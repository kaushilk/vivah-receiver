const { createClient } = require("@supabase/supabase-js");

function isUuid(v) {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
  );
}

function extractWeddingId(body) {
  const direct =
    body?.wedding_id ||
    body?.hidden?.wedding_id ||
    body?.data?.wedding_id ||
    body?.fields?.wedding_id;

  if (direct) return direct;

  const fields = body?.data?.fields;
  if (Array.isArray(fields)) {
    const match = fields.find((f) => f?.label === "wedding_id");
    if (match?.value) return match.value;
  }

  return null;
}

function extractProviderSubmissionId(body) {
  return body?.data?.submissionId || body?.data?.responseId || body?.eventId || null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(200).send("OK");

    const body = req.body || {};
    const weddingId = extractWeddingId(body);

    if (!isUuid(weddingId)) {
      return res.status(400).json({
        ok: false,
        error: "Missing/invalid wedding_id UUID in webhook payload.",
        received_wedding_id: weddingId ?? null,
        body_keys: Object.keys(body || {}),
        body_preview: JSON.stringify(body || {}).slice(0, 800),
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const providerSubmissionId = extractProviderSubmissionId(body);

    const { error } = await supabase.from("submissions_raw").insert({
      wedding_id: weddingId,
      provider: "tally",
      provider_submission_id: providerSubmissionId,
      payload: body,
    });

    if (error) {
      const msg = String(error.message || "").toLowerCase();
      const isDuplicate = msg.includes("duplicate") || msg.includes("unique");
      if (!isDuplicate) {
        return res.status(500).json({ ok: false, error: error.message });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};
