const { createClient } = require("@supabase/supabase-js");

function isUuid(v) {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
  );
}

/* =========================
   EXTRACTORS
   ========================= */

function extractFieldValueByLabel(body, label) {
  const fields = body?.data?.fields;
  if (!Array.isArray(fields)) return null;
  const match = fields.find((f) => f?.label === label);
  return match?.value ?? null;
}

function extractPublicCode(body) {
  return (
    body?.w ||
    body?.data?.w ||
    body?.fields?.w ||
    extractFieldValueByLabel(body, "w") ||
    null
  );
}

function extractFormType(body) {
  return extractFieldValueByLabel(body, "form_type");
}

function extractProviderSubmissionId(body) {
  return body?.data?.submissionId || body?.data?.responseId || body?.eventId || null;
}

function extractContactSheetFields(body) {
  const firstName = extractFieldValueByLabel(body, "first_name");
  const lastName = extractFieldValueByLabel(body, "last_name");
  const phoneRaw = extractFieldValueByLabel(body, "phone_number");
  const emailRaw = extractFieldValueByLabel(body, "email");

  const primaryName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;

  return {
    primary_name: primaryName,
    phone_raw: phoneRaw,
    email_raw: emailRaw,
    address_line_1: extractFieldValueByLabel(body, "address_line_1"),
    address_line_2: extractFieldValueByLabel(body, "address_line_2"),
    city: extractFieldValueByLabel(body, "city"),
    state: extractFieldValueByLabel(body, "state"),
    postal_code: extractFieldValueByLabel(body, "postal_code"),
    country: extractFieldValueByLabel(body, "country"),
  };
}

/* =========================
   NORMALIZERS
   ========================= */

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

function normalizeEmail(email) {
  if (!email) return null;
  return String(email).trim().toLowerCase();
}

/* =========================
   PROCESSORS
   ========================= */

async function upsertHouseholdFromContactSheet({ supabase, weddingId, rawSubmissionId, body }) {
  const extracted = extractContactSheetFields(body);

  const phoneNormalized = normalizePhone(extracted.phone_raw);
  const emailNormalized = normalizeEmail(extracted.email_raw);

  // For household dedupe + future comms, at least one contact channel is required.
  if (!phoneNormalized && !emailNormalized) {
    return {
      ok: false,
      status: 400,
      error: "Missing phone_number and email. Provide at least one so we can dedupe/update the household.",
    };
  }

  const payload = {
    wedding_id: weddingId,
    primary_name: extracted.primary_name || "Unknown",
    phone_raw: extracted.phone_raw,
    phone_normalized: phoneNormalized,
    email_raw: extracted.email_raw,
    email_normalized: emailNormalized,
    address_line_1: extracted.address_line_1,
    address_line_2: extracted.address_line_2,
    city: extracted.city,
    state: extracted.state,
    postal_code: extracted.postal_code,
    country: extracted.country,
    last_submission_id: rawSubmissionId,
    updated_at: new Date().toISOString(),
  };

  // Merge strategy to avoid creating a second household if someone submits with email first, then phone later:
  // 1) Try find existing by phone
  // 2) Else try find existing by email
  // 3) Else insert new
  let existing = null;

  if (phoneNormalized) {
    const { data, error } = await supabase
      .from("households")
      .select("id")
      .eq("wedding_id", weddingId)
      .eq("phone_normalized", phoneNormalized)
      .maybeSingle();

    if (error) return { ok: false, status: 500, error: error.message };
    existing = data || null;
  }

  if (!existing && emailNormalized) {
    const { data, error } = await supabase
      .from("households")
      .select("id")
      .eq("wedding_id", weddingId)
      .eq("email_normalized", emailNormalized)
      .maybeSingle();

    if (error) return { ok: false, status: 500, error: error.message };
    existing = data || null;
  }

  if (existing?.id) {
    const { error } = await supabase.from("households").update(payload).eq("id", existing.id);
    if (error) return { ok: false, status: 500, error: error.message };
    return { ok: true, household_id: existing.id, action: "updated" };
  }

  const { data, error } = await supabase.from("households").insert(payload).select("id").single();
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, household_id: data.id, action: "inserted" };
}

/* =========================
   ROUTER
   ========================= */

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(200).send("OK");

    const body = req.body || {};
    const publicCode = extractPublicCode(body);
    const formType = extractFormType(body);

    if (typeof publicCode !== "string" || publicCode.trim().length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Missing public wedding code. Expect a hidden field labeled 'w' (e.g. TT01).",
        received_w: publicCode ?? null,
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Resolve public wedding code -> internal wedding UUID
    const { data: weddingRow, error: lookupError } = await supabase
      .from("weddings")
      .select("wedding_id")
      .eq("public_code", publicCode)
      .maybeSingle();

    if (lookupError) {
      return res.status(500).json({ ok: false, error: lookupError.message });
    }

    const weddingId = weddingRow?.wedding_id ?? null;

    if (!isUuid(weddingId)) {
      return res.status(400).json({
        ok: false,
        error: "Unknown public wedding code (no matching wedding found).",
        received_w: publicCode,
      });
    }

    // Always write raw payload first (audit trail)
    const providerSubmissionId = extractProviderSubmissionId(body);

    let rawSubmissionId = null;

    const { data: rawInsert, error: insertError } = await supabase
      .from("submissions_raw")
      .insert({
        wedding_id: weddingId,
        provider: "tally",
        provider_submission_id: providerSubmissionId,
        payload: body,
      })
      .select("id")
      .single();

    if (insertError) {
      const msg = String(insertError.message || "").toLowerCase();
      const isDuplicate = msg.includes("duplicate") || msg.includes("unique");

      if (!isDuplicate) {
        return res.status(500).json({ ok: false, error: insertError.message });
      }

      // If duplicate, fetch the existing raw row id so downstream tables can reference it
      if (providerSubmissionId) {
        const { data: existingRaw, error: fetchError } = await supabase
          .from("submissions_raw")
          .select("id")
          .eq("wedding_id", weddingId)
          .eq("provider", "tally")
          .eq("provider_submission_id", providerSubmissionId)
          .maybeSingle();

        if (fetchError) return res.status(500).json({ ok: false, error: fetchError.message });
        rawSubmissionId = existingRaw?.id ?? null;
      }
    } else {
      rawSubmissionId = rawInsert?.id ?? null;
    }

    // Route to processor (business tables)
    if (formType === "contact_sheet") {
      const result = await upsertHouseholdFromContactSheet({
        supabase,
        weddingId,
        rawSubmissionId,
        body,
      });

      if (!result.ok) {
        return res.status(result.status || 500).json({ ok: false, error: result.error });
      }

      return res.status(200).json({
        ok: true,
        routed: "contact_sheet",
        household_id: result.household_id,
        action: result.action,
      });
    }

    // Default: raw-only (no processor)
    return res.status(200).json({ ok: true, routed: "raw_only", form_type: formType ?? null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};
