import crypto from "crypto";

/**
 * Verifica l'HMAC Shopify con timing-safe compare.
 * Usato sia per webhook orders/paid sia per GDPR webhooks.
 */
export function verifyShopifyHmac(
  rawBody: Buffer,
  receivedHmac: string,
  secret: string
): boolean {
  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  const a = Buffer.from(computed);
  const b = Buffer.from(receivedHmac);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifica HMAC per il lookup ERP (shared secret via query param).
 * Usa timing-safe compare per prevenire timing attacks.
 */
export function verifyErpToken(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
