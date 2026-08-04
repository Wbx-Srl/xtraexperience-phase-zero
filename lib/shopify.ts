const SHOPIFY_API_VERSION = "2025-04";

export function shopifyAdminUrl(shop: string, path: string): string {
  return `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
}

async function shopifyFetch(
  shop: string,
  accessToken: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = shopifyAdminUrl(shop, path);
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
      ...(options.headers ?? {}),
    },
  });
  return res;
}

// ── Metafield prodotto ────────────────────────────────────────────────────────

export interface ProductMetafields {
  url: string;
  cantina_name: string;
  cantina_email: string;
  instructions: string;
}

export async function getProductMetafields(
  shop: string,
  accessToken: string,
  productId: string
): Promise<ProductMetafields> {
  const res = await shopifyFetch(
    shop,
    accessToken,
    `products/${productId}/metafields.json?namespace=xw_experience`
  );
  if (!res.ok) throw new Error(`Metafield fetch failed: ${res.status}`);
  const data = await res.json();
  const mf: Record<string, string> = {};
  for (const m of data.metafields ?? []) {
    mf[m.key] = m.value;
  }
  return {
    url: mf["url"] ?? "",
    cantina_name: mf["cantina_name"] ?? "",
    cantina_email: mf["cantina_email"] ?? "",
    instructions: mf["instructions"] ?? "",
  };
}

// ── Tipo prodotto (fallback quando product_type è vuoto nel webhook) ────────────

export async function getProductType(
  shop: string,
  accessToken: string,
  productId: string
): Promise<string> {
  const res = await shopifyFetch(shop, accessToken, `products/${productId}.json?fields=product_type`);
  if (!res.ok) return "";
  const data = await res.json();
  return (data.product?.product_type as string) ?? "";
}

// ── Immagine prodotto (per il box "prodotto acquistato" nel modal voucher) ────

export async function getProductImage(
  shop: string,
  accessToken: string,
  productId: string
): Promise<string> {
  const res = await shopifyFetch(shop, accessToken, `products/${productId}.json?fields=image`);
  if (!res.ok) return "";
  const data = await res.json();
  return (data.product?.image?.src as string) ?? "";
}

// ── Metafield ordine ──────────────────────────────────────────────────────────

export async function writeOrderMetafield(
  shop: string,
  accessToken: string,
  orderId: string,
  vouchers: object[]
): Promise<void> {
  const res = await shopifyFetch(
    shop,
    accessToken,
    `orders/${orderId}/metafields.json`,
    {
      method: "POST",
      body: JSON.stringify({
        metafield: {
          namespace: "xw_experience",
          key: "vouchers",
          type: "json",
          value: JSON.stringify(vouchers),
        },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Order metafield write failed: ${res.status} ${body}`);
  }
}

// ── Discount Code (cross-selling) ─────────────────────────────────────────────

export async function createCrossSellingDiscount(
  shop: string,
  accessToken: string,
  discountCode: string,
  cantinaName: string,
  validityDays: number
): Promise<void> {
  const startsAt = new Date().toISOString();
  const endsAt = new Date(
    Date.now() + validityDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // Crea price rule
  const priceRuleRes = await shopifyFetch(
    shop,
    accessToken,
    "price_rules.json",
    {
      method: "POST",
      body: JSON.stringify({
        price_rule: {
          title: discountCode,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: "percentage",
          value: "-10.0",
          customer_selection: "all",
          starts_at: startsAt,
          ends_at: endsAt,
          usage_limit: 1,
          once_per_customer: true,
        },
      }),
    }
  );

  if (!priceRuleRes.ok) {
    const errBody = await priceRuleRes.text();
    // Scope mancante → log esplicito per diagnostica
    if (errBody.includes("write_price_rules")) {
      console.error(
        `[SCOPE MANCANTE] write_price_rules non autorizzato. ` +
        `Aggiungi lo scope in Partner Dashboard e reinstalla l'app. ` +
        `Dettagli: ${errBody}`
      );
    } else {
      console.error(`Price rule creation failed for ${discountCode}: ${errBody}`);
    }
    // Non bloccare il flusso principale
    return;
  }

  const priceRuleData = await priceRuleRes.json();
  const priceRuleId = priceRuleData.price_rule?.id;
  if (!priceRuleId) return;

  // Crea discount code
  const discountRes = await shopifyFetch(
    shop,
    accessToken,
    `price_rules/${priceRuleId}/discount_codes.json`,
    {
      method: "POST",
      body: JSON.stringify({ discount_code: { code: discountCode } }),
    }
  );

  if (!discountRes.ok) {
    console.error(
      `Discount code creation failed for ${discountCode}:`,
      await discountRes.text()
    );
  }
}

// ── Registrazione webhook ─────────────────────────────────────────────────────

export async function registerWebhook(
  shop: string,
  accessToken: string,
  topic: string,
  address: string
): Promise<void> {
  await shopifyFetch(shop, accessToken, "webhooks.json", {
    method: "POST",
    body: JSON.stringify({
      webhook: { topic, address, format: "json" },
    }),
  });
}
