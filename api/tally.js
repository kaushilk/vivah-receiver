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

function extractHouseId(body) {
  return extractFieldValueByLabel(body, "house_id");
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

function extractRsvpFields(body) {
  const rsvpStatus = extractFieldValueByLabel(body, "rsvp_status");
  const eventsAttending = extractFieldValueByLabel(body, "events_attending");
  const dietaryNotes = extractFieldValueByLabel(body, "dietary_notes");
  const questions = extractFieldValueByLabel(body, "questions");
  const partySize = extractFieldValueByLabel(body, "party_size");

  return {
    rsvp_status: rsvpStatus,
    events_attending: Array.isArray(eventsAttending)
      ? eventsAttending.filter((v) => typeof v === "string" && v.trim().length > 0)
      : null,
    dietary_notes: typeof dietaryNotes === "string" ? dietaryNotes : null,
    questions: typeof questions === "string" ? questions : null,
    party_size:
      typeof partySize === "number"
        ? partySize
        : typeof partySize === "string" && partySize.trim() !== ""
          ? Number(partySize)
          : null,
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

async function updateHouseholdFromRsvp({ supabase, weddingId, rawSubmissionId, body }) {
  const houseId = extractHouseId(body);

  if (!isUuid(houseId)) {
    return {
      ok: false,
      status: 400,
      error: "Missing or invalid house_id. Expect a UUID in hidden field labeled 'house_id'.",
      received_house_id: houseId ?? null,
    };
  }

  const fields = extractRsvpFields(body);

  const normalizedStatus =
    typeof fields.rsvp_status === "string" ? fields.rsvp_status.trim().toLowerCase() : null;

  if (normalizedStatus !== "yes" && normalizedStatus !== "no") {
    return {
      ok: false,
      status: 400,
      error: "Missing or invalid rsvp_status. Expected 'yes' or 'no'.",
      received_rsvp_status: fields.rsvp_status ?? null,
    };
  }

  // Only update optional fields if they were present on the form submission.
  // This allows different weddings to have different RSVP forms without wiping data.
  const updatePayload = {
    rsvp_status: normalizedStatus,
    last_submission_id: rawSubmissionId,
    updated_at: new Date().toISOString(),
  };

  if (fields.party_size !== null && !Number.isNaN(fields.party_size)) {
    updatePayload.party_size = fields.party_size;
  }

  if (fields.dietary_notes !== null) {
    updatePayload.dietary_notes = fields.dietary_notes;
  }

  if (fields.questions !== null) {
    updatePayload.questions = fields.questions;
  }

  if (fields.events_attending !== null) {
    updatePayload.events_attending = fields.events_attending;
  }

  // Ensure the household belongs to this wedding (prevents cross-wedding updates)
  const { data: existing, error: fetchError } = await supabase
    .from("households")
    .select("id")
    .eq("id", houseId)
    .eq("wedding_id", weddingId)
    .maybeSingle();

  if (fetchError) return { ok: false, status: 500, error: fetchError.message };
  if (!existing?.id) {
    return {
      ok: false,
      status: 404,
      error: "Household not found for this wedding (invalid house_id for this w).",
      received_house_id: houseId,
    };
  }

  const { error: updateError } = await supabase
    .from("households")
    .update(updatePayload)
    .eq("id", houseId);

  if (updateError) return { ok: false, status: 500, error: updateError.message };

  return { ok: true, household_id: houseId, action: "updated_rsvp" };
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

    if (formType === "rsvp") {
      const result = await updateHouseholdFromRsvp({
        supabase,
        weddingId,
        rawSubmissionId,
        body,
      });

      if (!result.ok) {
        return res
          .status(result.status || 500)
          .json({ ok: false, error: result.error, ...result });
      }

      return res.status(200).json({
        ok: true,
        routed: "rsvp",
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
