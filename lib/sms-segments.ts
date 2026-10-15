// SMS segment counting (pentest 2026-10-13, messaging).
//
// The old code assumed 160 characters per SMS for every message. A message with any
// character outside the GSM-7 alphabet (an emoji, a curly quote, many accented letters)
// is sent as UCS-2, which carries only 70 characters per SMS (67 per part when split).
// Charging the 160-character rate for those messages undercharged the SACCO's wallet,
// and the gateway bills the real segment count.

// GSM 03.38 basic character set.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// GSM extension table: each costs two septets.
const GSM_EXTENSION = "^{}\\[~]|€\f";

const BASIC = new Set(GSM_BASIC);
const EXT = new Set(GSM_EXTENSION);

/** Returns the number of SMS segments the message will be billed as. */
export function smsSegments(message: string): number {
  const text = String(message ?? '');
  if (text.length === 0) return 1;

  let isGsm = true;
  let septets = 0;
  for (const ch of text) {
    if (BASIC.has(ch)) {
      septets += 1;
    } else if (EXT.has(ch)) {
      septets += 2;
    } else {
      isGsm = false;
      break;
    }
  }

  if (isGsm) {
    return septets <= 160 ? 1 : Math.ceil(septets / 153);
  }
  // UCS-2 is counted in UTF-16 code units (emoji count as 2).
  const units = text.length;
  return units <= 70 ? 1 : Math.ceil(units / 67);
}
