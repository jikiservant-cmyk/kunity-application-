// SECURITY (pentest 2026-10-13): the SMS top-up price list lives on the server.
// The client sends only the number of credits; the price is looked up here, so a
// caller can never buy credits at a price they chose.
export const SMS_PACKS = [
  { credits: 200, price: 10000 },
  { credits: 500, price: 25000 },
  { credits: 1200, price: 50000 },
  { credits: 3000, price: 100000 },
] as const;

export function packForCredits(credits: unknown): { credits: number; price: number } | null {
  if (typeof credits !== 'number' || !Number.isInteger(credits)) return null;
  return SMS_PACKS.find((p) => p.credits === credits) ?? null;
}

export function packForPrice(price: unknown): { credits: number; price: number } | null {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  return SMS_PACKS.find((p) => p.price === price) ?? null;
}

// Uganda mobile money: 07XXXXXXXX, 2567XXXXXXXX or +2567XXXXXXXX (spaces allowed).
export function normalizeUgMomo(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.replace(/[\s-]/g, '');
  const m = /^(?:\+?256|0)(7\d{8})$/.exec(s);
  return m ? `+256${m[1]}` : null;
}
