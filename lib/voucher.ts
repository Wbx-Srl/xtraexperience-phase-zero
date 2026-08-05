import crypto from "crypto";

// Crockford Base32 alphabet (no I, L, O, U — evita ambiguità visive)
const CROCKFORD_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function toCrockfordBase32(buf: Buffer): string {
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += CROCKFORD_CHARS[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += CROCKFORD_CHARS[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

/**
 * Genera codice voucher deterministico nel formato XW-XXXX-XXXX.
 * Input: orderId + lineItemId + VOUCHER_SECRET_SALT
 */
export function generateVoucherCode(
  orderId: string,
  lineItemId: string,
  salt: string
): string {
  const hash = crypto
    .createHmac("sha256", salt)
    .update(`${orderId}:${lineItemId}`)
    .digest();

  const encoded = toCrockfordBase32(hash).slice(0, 8).toUpperCase();
  return `XW-${encoded.slice(0, 4)}-${encoded.slice(4, 8)}`;
}

/**
 * Genera codice sconto cross-selling nel formato {CANTINA_SLUG}-XW-{4CHAR}
 */
export function generateDiscountCode(
  cantinaName: string,
  orderId: string,
  salt: string
): string {
  const slug = cantinaName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
  const hash = crypto
    .createHmac("sha256", salt)
    .update(`discount:${orderId}:${cantinaName}`)
    .digest();
  const suffix = toCrockfordBase32(hash).slice(0, 4).toUpperCase();
  return `${slug}-XW-${suffix}`;
}

export interface VoucherRecord {
  line_item_id: string;
  order_id: string;
  code: string;
  cantina_name: string;
  cantina_email: string;
  cantina_phone: string;
  experience_name: string;
  image_url: string;
  url_experience: string;
  instructions: string;
  discount_code: string;
  discount_description: string;
  status: "generated" | "used" | "expired" | "refunded";
  generated_at: string;
  expires_at: string;
  customer_email: string;
  customer_name: string;
  order_number: string;
  payment_gateway: string;
}

export interface OrderVoucherSummary {
  line_item_id: string;
  code: string;
  cantina_name: string;
  experience_name: string;
  expires_at: string;
  status: string;
}
