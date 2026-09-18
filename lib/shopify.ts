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
  cantina_phone: string;
  cantina_address: string;
  validity_months: string;
  instructions: string;
  driving_directions: string;
  referrer: string;
}

export async function getProductMetafields(
  shop: string,
  accessToken: string,
  productId: string
): Promise<ProductMetafields> {
  // cantina_name/url/instructions live in the xw_experience namespace
  // (dedicated to this app); booking email/phone are theme-wide fields
  // already used across the Xperience PDP, under the xtrawine namespace
  // (xtrawine.xpBookingEMail / xtrawine.xpBookingPhone) — two separate
  // namespaces, fetched in parallel.
  const [experienceRes, xtrawineRes] = await Promise.all([
    shopifyFetch(
      shop,
      accessToken,
      `products/${productId}/metafields.json?namespace=xw_experience`
    ),
    shopifyFetch(
      shop,
      accessToken,
      `products/${productId}/metafields.json?namespace=xtrawine`
    ),
  ]);
  if (!experienceRes.ok) throw new Error(`Metafield fetch failed: ${experienceRes.status}`);
  const data = await experienceRes.json();
  const mf: Record<string, string> = {};
  for (const m of data.metafields ?? []) {
    mf[m.key] = m.value;
  }

  const xtrawineMf: Record<string, string> = {};
  if (xtrawineRes.ok) {
    const xtrawineData = await xtrawineRes.json();
    for (const m of xtrawineData.metafields ?? []) {
      xtrawineMf[m.key] = m.value;
    }
  }

  return {
    url: mf["url"] ?? "",
    cantina_name: xtrawineMf["xpWineryName"] ?? "",
    cantina_email: xtrawineMf["xpBookingEMail"] ?? "",
    cantina_phone: xtrawineMf["xpBookingPhone"] ?? "",
    cantina_address: xtrawineMf["xpAddress"] ?? "",
    validity_months: xtrawineMf["xpVoucherValidityMonths"] ?? "",
    instructions: xtrawineMf["xpBookingInstructions"] ?? "",
    driving_directions: xtrawineMf["xpDrivingDirections"] ?? "",
    referrer: xtrawineMf["xpBookingReferrer"] ?? "",
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

/**
 * Risolve gli id dei prodotti VINO ATTIVI (product_type=Wines, status=active)
 * di un dato vendor (cantina) - esclude Xperience/Olio/Food/altri tipi dello
 * stesso vendor, che altrimenti risulterebbero idonei allo sconto
 * cross-selling insieme al vino, ed esclude prodotti draft/archiviati (non
 * acquistabili, inutili nello sconto). Filtrato anche perche' l'API
 * price_rules.json di Shopify ha un limite HARD di 100 entitled_product_ids
 * (non 250 come il paging REST) - una cantina con >100 referenze vino
 * avrebbe altrimenti fatto fallire la creazione del price rule (visto in
 * produzione con Tasca d'Almerita, 209 prodotti totali di vendor prima del
 * filtro per tipo).
 */
async function getVendorProductIds(
  shop: string,
  accessToken: string,
  vendor: string
): Promise<number[]> {
  const res = await shopifyFetch(
    shop,
    accessToken,
    `products.json?vendor=${encodeURIComponent(vendor)}&product_type=${encodeURIComponent("Wines")}&status=active&limit=100&fields=id`
  );
  if (!res.ok) {
    console.error(`Lookup vini per vendor "${vendor}" fallito: ${res.status}`);
    return [];
  }
  const data = await res.json();
  const products = (data.products ?? []) as { id: number }[];
  if (products.length === 100) {
    console.error(
      `[POSSIBILE TRONCAMENTO] vendor "${vendor}" ha >= 100 vini, oltre il ` +
      `limite entitled_product_ids di Shopify - sconto creato solo sui ` +
      `primi 100, serve entitled_collection_ids per coprirli tutti.`
    );
  }
  return products.map((p) => p.id);
}

export async function createCrossSellingDiscount(
  shop: string,
  accessToken: string,
  discountCode: string,
  vendor: string,
  validityDays: number
): Promise<void> {
  const startsAt = new Date().toISOString();
  const endsAt = new Date(
    Date.now() + validityDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // Limita lo sconto ai soli prodotti della cantina (stesso vendor Shopify
  // del prodotto Xperience acquistato) - prima era target_selection:"all",
  // valido su tutto il catalogo.
  const entitledProductIds = await getVendorProductIds(shop, accessToken, vendor);
  if (entitledProductIds.length === 0) {
    console.error(
      `Nessun prodotto trovato per vendor "${vendor}" - sconto cross-selling non creato.`
    );
    return;
  }

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
          target_selection: "entitled",
          entitled_product_ids: entitledProductIds,
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
