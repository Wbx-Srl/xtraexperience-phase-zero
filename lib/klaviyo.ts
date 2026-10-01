import type { ProductTranslation, VoucherEmailLanguage } from "@/lib/shopify";

const KLAVIYO_API_URL = "https://a.klaviyo.com/api/events/";

async function trackEvent(
  apiKey: string,
  email: string,
  eventName: string,
  properties: Record<string, string>,
  uniqueId: string
): Promise<void> {
  const res = await fetch(KLAVIYO_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      "Content-Type": "application/json",
      revision: "2024-10-15",
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          metric: {
            data: { type: "metric", attributes: { name: eventName } },
          },
          profile: {
            data: { type: "profile", attributes: { email } },
          },
          unique_id: uniqueId,
          properties,
        },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Klaviyo Track failed [${eventName}]: ${res.status} ${body}`);
  }
}

// Campi tradotti mandati anche con suffisso di lingua (experience_name_it,
// experience_name_en, ...), per i template Klaviyo divisi per lingua.
export type TranslatedVoucherField = keyof ProductTranslation;

export type VoucherTranslatedFields = {
  [K in `${TranslatedVoucherField}_${VoucherEmailLanguage}`]: string;
};

export type VoucherGeneratedPayload = VoucherGeneratedBasePayload & VoucherTranslatedFields;

interface VoucherGeneratedBasePayload extends Record<string, string> {
  code: string;
  cantina_name: string;
  cantina_email: string;
  cantina_phone: string;
  cantina_address: string;
  experience_name: string;
  image_url: string;
  url_experience: string;
  expires_at: string;
  qr_url: string;
  order_number: string;
  instructions: string;
  driving_directions: string;
  referrer: string;
  discount_code: string;
  discount_description: string;
  payment_gateway: string;
  // Lingua dell'ordine (order.customer_locale, es. "it", "en", "de")
  locale: string;
}

export interface VoucherSoldPayload extends Record<string, string> {
  code: string;
  customer_name: string;
  customer_email: string;
  experience_name: string;
  order_number: string;
  expires_at: string;
}

/**
 * Triggera l'evento "Voucher Generated" sul profilo del cliente.
 * 1 evento per voucher → 1 email per biglietto.
 */
export async function trackVoucherGenerated(
  apiKey: string,
  customerEmail: string,
  payload: VoucherGeneratedPayload
): Promise<void> {
  await trackEvent(
    apiKey,
    customerEmail,
    "Voucher Generated",
    payload,
    `voucher-generated-${payload.code}`
  );
}

/**
 * Triggera l'evento "Voucher Sold" sul profilo della cantina.
 */
export async function trackVoucherSold(
  apiKey: string,
  cantinaEmail: string,
  payload: VoucherSoldPayload
): Promise<void> {
  await trackEvent(
    apiKey,
    cantinaEmail,
    "Voucher Sold",
    payload,
    `voucher-sold-${payload.code}`
  );
}
