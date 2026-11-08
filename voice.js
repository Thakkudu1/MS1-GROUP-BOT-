require("dotenv").config();

/**
 * Send the normal WhatsApp text reply first, then an optional AI-generated
 * voice note. Keep API credentials in host environment variables, never Git.
 */
async function sendVoiceReply(sock, chat, text, quoted) {
  const body = String(text ?? "");
  const options = quoted ? { quoted } : {};
  const sent = await sock.sendMessage(chat, { text: body }, options);

  if (String(process.env.VOICE_REPLIES || "true").toLowerCase() === "false") return sent;
  const apiKey = String(process.env.SARVAM_API_KEY || "").trim();
  const voiceId = String(process.env.SARVAM_VOICE_ID || "").trim();
  if (!apiKey || !voiceId) {
    console.log("[VOICE] Text sent; configure SARVAM_API_KEY and SARVAM_VOICE_ID to enable audio.");
    return sent;
  }
  if (!body.trim() || body.length > 1000) {
    console.log("[VOICE] Audio skipped: voice API accepts 1–1000 characters per request.");
    return sent;
  }

  try {
    const form = new FormData();
    form.set("voice_id", voiceId);
    form.set("text", body);
    form.set("output_audio_codec", "opus");
    form.set("speech_sample_rate", "24000");
    const language = String(process.env.VOICE_LANGUAGE || "").trim();
    if (language) form.set("language_code", language);

    const response = await fetch("https://api.sarvam.ai/voices/clone", {
      method: "POST",
      headers: { "api-subscription-key": apiKey },
      body: form
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error("Sarvam API " + response.status + ": " + (data.message || data.error || "voice generation failed"));
    }
    const encoded = data.audio_b64 || data.audio;
    if (!encoded) throw new Error("API response did not include audio data");

    await sock.sendMessage(chat, {
      audio: Buffer.from(encoded, "base64"),
      mimetype: "audio/ogg; codecs=opus",
      ptt: true
    }, options);
    console.log("[VOICE] Voice note sent", JSON.stringify({ chat, chars: body.length, requestId: data.request_id || null }));
  } catch (error) {
    // Voice failures must never stop existing bot commands or text replies.
    console.error("[VOICE] Generation/send failed; text reply was preserved:", error?.message || error);
  }
  return sent;
}

module.exports = { sendVoiceReply };
