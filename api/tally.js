const { createClient } = require("@supabase/supabase-js");

function isUuid(v) {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
  );
}

function extractFieldValueByLabel(body, label) {
  const fields = body?.data?.fields;
  if (!Array.isArray(fields)) return null;
  const match = fields.find((f) => f?.label === label);
  return match?.value ?? null;
}

function extractPublicCode(body) {
  // Try common places (harmless to keep), then Tally fields array
  return (
    body?.w ||
    body?.data?.w ||
    body?.fields?.w ||
    extractFieldValueByLabel(body, "w") ||
    null
  );
}

function extractProviderSubmissionId(body) {
  return body?.data?.submissionId || body?.data?.responseId || body?.eventId || null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(200).send("OK");

    const body = req.body || {};
    const publicCode = extractPublicCode(body);

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

    // Lookup UUID from weddings.public_code
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

    const providerSubmissionId = extractProviderSubmissionId(body);

    const { error: insertError } = await supabase.from("submissions_raw").insert({
      wedding_id: weddingId,
      provider: "tally",
      provider_submission_id: providerSubmissionId,
      payload: body,
    });

    if (insertError) {
      const msg = String(insertError.message || "").toLowerCase();
      const isDuplicate = msg.includes("duplicate") || msg.includes("unique");
      if (!isDuplicate) {
        return res.status(500).json({ ok: false, error: insertError.message });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};
