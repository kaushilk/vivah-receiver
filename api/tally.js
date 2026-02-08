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

function getFieldsArray(body) {
  const fields = body?.data?.fields;
  return Array.isArray(fields) ? fields : [];
}

function findFieldByLabel(body, label) {
  const fields = getFieldsArray(body);
  return fields.find((f) => f?.label === label) || null;
}

function extractPublicCode(body) {
  // Hidden field labeled "w"
  const hidden = findFieldByLabel(body, "w");
  return hidden?.value ?? null;
}

function extractFormType(body) {
  const f = findFieldByLabel(body, "form_type");
  return f?.value ?? null;
}

function extractHouseId(body) {
  const f = findFieldByLabel(body, "house_id");
  return f?.value ?? null;
}

function extractProviderSubmissionId(body) {
  return body?.data?.submissionId || body?.data?.responseId || body?.eventId || null;
}

// Converts dropdown/checkbox option IDs -> option text when Tally provides options[]
function resolveOptionTexts(field) {
  if (!field) return null;

  const value = field.value;

  // If it's already a string/number/bool, return as-is
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  // If it's an array (dropdown multi / checkboxes), map ids -> option text when possible
  if (Array.isArray(value)) {
    const options = Array.isArray(field.options) ? field.options : [];
    const idToText = new Map(options.map((o) => [o?.id, o?.text]));

    // If items look like ids and we can map, return text; otherwise return original items
    return value
      .map((v) => (idToText.has(v) ? idToText.get(v) : v))
      .filter((v) => v !== null && v !== undefined);
  }

  return null;
}

function extractContactSheetFields(body) {
  const firstName = findFieldByLabel(body, "first_name")?.value ?? null;
  const lastName = findFieldByLabel(body, "last_name")?.value ?? null;
  const phoneRaw = findFieldByLabel(body, "phone_number")?.value ?? null;
  const emailRaw = findFieldByLabel(body, "email")?.value ?? null;

  const primaryName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;

  return {
    primary_name: primaryName,
    phone_raw: phoneRaw,
    email_raw: emailRaw,
    address_line_1: findFieldByLabel(body, "address_line_1")?.value ?? null,
    address_line_2: findFieldByLabel(body, "address_line_2")?.value ?? null,
    city: findFieldByLabel(body, "city")?.value ?? null,
    state: findFieldByLabel(body, "state")?.value ?? null,
    postal_code: findFieldByLabel(body, "postal_code")?.value ?? null,
    country: findFieldByLabel(body, "country")?.value ?? null,
  };
}

function extractRsvpFields(body) {
  const rsvpField = findFieldByLabel(body, "rsvp_status");
  const eventsField = findFieldByLabel(body, "events_attending");
  const dietaryField = findFieldByLabel(body, "dietary_notes");
  const questionsField = findFieldByLabel(body, "questions");
  const partySizeField = findFieldByLabel(body, "party_size");

  const rsvpResolved = resolveOptionTexts(rsvpField);
  const eventsResolved = resolveOptionTexts(eventsField);

  const rsvpText =
    Array.isArray(rsvpResolved) ? rsvpResolved[0] : rsvpResolved; // dropdown sometimes array

  return {
    rsvp_status: typeof rsvpText === "string" ? rsvpText : null,
    events_attending: Array.isArray(eventsResolved)
      ? eventsResolved.filter((v) => typeof v === "string" && v.trim().length > 0)
      : null,
    dietary_notes:
      typeof dietaryField?.value === "string" ? dietaryField.value : dietaryField?.value ?? null,
    questions:
      typeof questionsField?.value === "string" ? questionsField.value : questionsField?.value ?? null,
    party_size:
      typeof partySizeField?.value === "number"
        ? partySizeField.value
        : typeof partySizeField?.value === "string" && partySizeField.value.trim() !== ""
          ? Number(partySizeField.value)
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

function normalizeRsvpStatus(s) {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  if (v === "yes" || v === "y") return "yes";
  if (v === "no" || v === "n") return "no";
  return null;
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

async function updateGuestsFromRsvp({ supabase, weddingId, rawSubmissionId, body }) {
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
  const status = normalizeRsvpStatus(fields.rsvp_status);

  if (!status) {
    return {
      ok: false,
      status: 400,
      error: "Missing or invalid rsvp_status. Expected option text 'Yes'/'No' (stored as yes/no).",
      received_rsvp_status: fields.rsvp_status ?? null,
    };
  }

  // Build update payload for guests
  const updatePayload = {
    rsvp_status: status,
    updated_at: new Date().toISOString(),
  };

  if (fields.dietary_notes !== null) {
    updatePayload.dietary_notes = fields.dietary_notes;
  }

  if (fields.questions !== null) {
    updatePayload.questions = fields.questions;
  }

  if (fields.events_attending !== null) {
    updatePayload.events_attending = fields.events_attending;
  }

  // Verify household exists for this wedding
  const { data: household, error: fetchError } = await supabase
    .from("households")
    .select("id")
    .eq("id", houseId)
    .eq("wedding_id", weddingId)
    .maybeSingle();

  if (fetchError) return { ok: false, status: 500, error: fetchError.message };
  if (!household?.id) {
    return {
      ok: false,
      status: 404,
      error: "Household not found for this wedding (invalid house_id for this w).",
      received_house_id: houseId,
    };
  }

  // Update ALL guests in the household with the RSVP data
  const { error: updateError, count } = await supabase
    .from("guests")
    .update(updatePayload)
    .eq("household_id", houseId)
    .eq("wedding_id", weddingId);

  if (updateError) return { ok: false, status: 500, error: updateError.message };

  return { ok: true, household_id: houseId, guests_updated: count || 0, action: "updated_rsvp" };
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

    if (lookupError) return res.status(500).json({ ok: false, error: lookupError.message });

    const weddingId = weddingRow?.wedding_id ?? null;

    if (!isUuid(weddingId)) {
      return res.status(400).json({
        ok: false,
        error: "Unknown public wedding code (no matching wedding found).",
        received_w: publicCode,
      });
    }

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

      if (!isDuplicate) return res.status(500).json({ ok: false, error: insertError.message });

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

    if (formType === "contact_sheet") {
      const result = await upsertHouseholdFromContactSheet({
        supabase,
        weddingId,
        rawSubmissionId,
        body,
      });

      if (!result.ok) return res.status(result.status || 500).json({ ok: false, error: result.error });

      return res.status(200).json({
        ok: true,
        routed: "contact_sheet",
        household_id: result.household_id,
        action: result.action,
      });
    }

    if (formType === "rsvp") {
      const result = await updateGuestsFromRsvp({
        supabase,
        weddingId,
        rawSubmissionId,
        body,
      });

      if (!result.ok) return res.status(result.status || 500).json({ ok: false, ...result });

      return res.status(200).json({
        ok: true,
        routed: "rsvp",
        household_id: result.household_id,
        guests_updated: result.guests_updated,
        action: result.action,
      });
    }

    return res.status(200).json({ ok: true, routed: "raw_only", form_type: formType ?? null });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};