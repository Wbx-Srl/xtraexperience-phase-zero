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
  productId: string,
  // Produttore della riga d'ordine: nome cantina quando xpWineryName e' vuoto
  vendor = ""
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
    cantina_name: xtrawineMf["xpWineryName"] || vendor,
    cantina_email: xtrawineMf["xpBookingEMail"] ?? "",
    cantina_phone: xtrawineMf["xpBookingPhone"] ?? "",
    cantina_address: xtrawineMf["xpAddress"] ?? "",
    validity_months: xtrawineMf["xpVoucherValidityMonths"] ?? "",
    instructions: xtrawineMf["xpBookingInstructions"] ?? "",
    driving_directions: xtrawineMf["xpDrivingDirections"] ?? "",
    referrer: xtrawineMf["xpBookingReferrer"] ?? "",
  };
}

// ── Traduzioni prodotto (email voucher Klaviyo) ───────────────────────────────

// L'Admin REST di getProductMetafields restituisce solo la lingua base del
// negozio: le traduzioni di Translate & Adapt si leggono dalla Storefront API
// con @inContext, come fa il popup voucher del tema. Token Storefront pubblico
// (lo stesso del tema), nessuno scope Admin in piu'.
const STOREFRONT_API_VERSION = "2026-04";

// Lingue mandate a Klaviyo come campi con suffisso (experience_name_it, ...).
// Aggiungere una lingua = aggiungere il codice qui.
export const VOUCHER_EMAIL_LANGUAGES = ["it", "en"] as const;
export type VoucherEmailLanguage = (typeof VOUCHER_EMAIL_LANGUAGES)[number];

export interface ProductTranslation {
  experience_name: string;
  instructions: string;
  driving_directions: string;
  cantina_address: string;
}

async function getProductTranslation(
  shop: string,
  storefrontToken: string,
  productId: string,
  language: VoucherEmailLanguage,
  fallback: ProductTranslation
): Promise<ProductTranslation> {
  const res = await fetch(`https://${shop}/api/${STOREFRONT_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": storefrontToken,
    },
    body: JSON.stringify({
      query: `query VoucherTranslations($id: ID!, $language: LanguageCode!)
        @inContext(language: $language) {
        product(id: $id) {
          title
          instructions: metafield(namespace: "xtrawine", key: "xpBookingInstructions") { value }
          directions: metafield(namespace: "xtrawine", key: "xpDrivingDirections") { value }
          address: metafield(namespace: "xtrawine", key: "xpAddress") { value }
        }
      }`,
      variables: {
        id: `gid://shopify/Product/${productId}`,
        language: language.toUpperCase(),
      },
    }),
  });
  if (!res.ok) {
    console.error(`Traduzione ${language} prodotto ${productId} fallita: ${res.status}`);
    return fallback;
  }
  const data = await res.json();
  if (data.errors) {
    console.error(`Traduzione ${language} prodotto ${productId}: ${JSON.stringify(data.errors)}`);
    return fallback;
  }
  const product = data.data?.product as {
    title?: string;
    instructions: { value: string } | null;
    directions: { value: string } | null;
    address: { value: string } | null;
  } | null;
  if (!product) {
    console.error(`Traduzione ${language} prodotto ${productId}: prodotto non visibile sulla Storefront`);
    return fallback;
  }
  return {
    experience_name: product.title || fallback.experience_name,
    instructions: product.instructions?.value || fallback.instructions,
    driving_directions: product.directions?.value || fallback.driving_directions,
    cantina_address: product.address?.value || fallback.cantina_address,
  };
}

/**
 * Testi del prodotto tradotti in ogni lingua di VOUCHER_EMAIL_LANGUAGES.
 * Best effort: senza token, con errore o campo vuoto si usa il valore base
 * (fallback), cioe' l'email resta com'era prima delle traduzioni.
 */
export async function getProductTranslations(
  shop: string,
  productId: string,
  fallback: ProductTranslation
): Promise<Record<VoucherEmailLanguage, ProductTranslation>> {
  const storefrontToken = process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!storefrontToken) {
    console.error("SHOPIFY_STOREFRONT_TOKEN mancante: email voucher nella lingua base.");
  }
  const entries = await Promise.all(
    VOUCHER_EMAIL_LANGUAGES.map(async (language) => {
      if (!storefrontToken) return [language, fallback] as const;
      try {
        return [
          language,
          await getProductTranslation(shop, storefrontToken, productId, language, fallback),
        ] as const;
      } catch (e) {
        console.error(`Traduzione ${language} prodotto ${productId} fallita:`, e);
        return [language, fallback] as const;
      }
    })
  );
  return Object.fromEntries(entries) as Record<VoucherEmailLanguage, ProductTranslation>;
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

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[‘’]/g, "'");
}

function handleize(value: string): string {
  return normalizeName(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Risolve l'id della collection del produttore (cantina) tra le collection
 * del prodotto Xperience acquistato. Il tema la trova confrontando
 * xtrawine.entityId della collection con il campo "key" del metaobject
 * vendorMetaobject del prodotto, ma l'app non ha lo scope read_metaobjects:
 * qui si sceglie la collection con xtrawine.entityId valorizzato (le
 * collection produttore e zona ce l'hanno, le altre no) il cui titolo o
 * handle corrisponde al vendor (es. "Tasca d'Almerita" / tasca-d-almerita).
 * Ritorna null se non la trova: il chiamante torna alla lista di prodotti.
 */
async function getProducerCollectionId(
  shop: string,
  accessToken: string,
  productId: string,
  vendor: string
): Promise<number | null> {
  const res = await shopifyFetch(shop, accessToken, "graphql.json", {
    method: "POST",
    body: JSON.stringify({
      query: `query ProducerCollections($id: ID!) {
        product(id: $id) {
          collections(first: 250) {
            nodes {
              legacyResourceId
              title
              handle
              entityId: metafield(namespace: "xtrawine", key: "entityId") {
                value
              }
            }
          }
        }
      }`,
      variables: { id: `gid://shopify/Product/${productId}` },
    }),
  });
  if (!res.ok) {
    console.error(`Lookup collection produttore per prodotto ${productId} fallito: ${res.status}`);
    return null;
  }
  const data = await res.json();
  if (data.errors) {
    console.error(`Lookup collection produttore per prodotto ${productId}: ${JSON.stringify(data.errors)}`);
    return null;
  }
  const nodes = (data.data?.product?.collections?.nodes ?? []) as {
    legacyResourceId: string;
    title: string;
    handle: string;
    entityId: { value: string } | null;
  }[];
  const vendorName = normalizeName(vendor);
  const vendorHandle = handleize(vendor);
  const match = nodes.find(
    (c) =>
      c.entityId?.value &&
      (normalizeName(c.title) === vendorName || c.handle === vendorHandle)
  );
  return match ? Number(match.legacyResourceId) : null;
}

export async function createCrossSellingDiscount(
  shop: string,
  accessToken: string,
  discountCode: string,
  vendor: string,
  productId: string,
  validityDays: number
): Promise<void> {
  const startsAt = new Date().toISOString();
  const endsAt = new Date(
    Date.now() + validityDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // Sconto sulla collection del produttore (cantina), cosi' vale anche sui
  // prodotti che entrano nel catalogo durante l'anno di validita' e non ha
  // il limite di 100 entitled_product_ids. Se la collection non si trova,
  // resta il comportamento precedente: vini attivi del vendor al momento
  // dell'ordine.
  const collectionId = await getProducerCollectionId(shop, accessToken, productId, vendor);
  let entitlement: { entitled_collection_ids: number[] } | { entitled_product_ids: number[] };
  if (collectionId) {
    entitlement = { entitled_collection_ids: [collectionId] };
  } else {
    console.error(
      `Collection produttore non trovata per vendor "${vendor}" (prodotto ${productId}) - sconto sui vini del vendor.`
    );
    const entitledProductIds = await getVendorProductIds(shop, accessToken, vendor);
    if (entitledProductIds.length === 0) {
      console.error(
        `Nessun prodotto trovato per vendor "${vendor}" - sconto cross-selling non creato.`
      );
      return;
    }
    entitlement = { entitled_product_ids: entitledProductIds };
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
          ...entitlement,
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

/**
 * Elimina il codice sconto cross-selling di un voucher annullato/rimborsato.
 * Il price_rule_id non e' salvato nel VoucherRecord, quindi si risale dal
 * codice (discount_codes/lookup, che risponde con redirect al discount code).
 * Ogni price rule contiene un solo codice (uno per voucher, vedi
 * generateDiscountCode), quindi si elimina l'intera price rule.
 * Best effort: logga e non lancia, codice gia' eliminato = nessuna azione.
 */
export async function deleteCrossSellingDiscount(
  shop: string,
  accessToken: string,
  discountCode: string
): Promise<void> {
  const lookupRes = await shopifyFetch(
    shop,
    accessToken,
    `discount_codes/lookup.json?code=${encodeURIComponent(discountCode)}`
  );
  if (lookupRes.status === 404) {
    console.log(`Codice sconto ${discountCode} non trovato (gia' eliminato?), skip.`);
    return;
  }
  if (!lookupRes.ok) {
    console.error(`Lookup codice sconto ${discountCode} fallito: ${lookupRes.status} ${await lookupRes.text()}`);
    return;
  }
  const lookupData = await lookupRes.json();
  const priceRuleId = lookupData.discount_code?.price_rule_id;
  if (!priceRuleId) {
    console.error(`Lookup codice sconto ${discountCode}: price_rule_id assente nella risposta.`);
    return;
  }

  const deleteRes = await shopifyFetch(shop, accessToken, `price_rules/${priceRuleId}.json`, {
    method: "DELETE",
  });
  if (!deleteRes.ok && deleteRes.status !== 404) {
    console.error(`Eliminazione price rule ${priceRuleId} (${discountCode}) fallita: ${deleteRes.status} ${await deleteRes.text()}`);
    return;
  }
  console.log(`Codice sconto ${discountCode} eliminato (price rule ${priceRuleId}).`);
}

/**
 * Aggiorna lo status dei voucher annullati nel metafield ordine
 * xw_experience.vouchers (scritto da writeOrderMetafield). Best effort:
 * il KV resta la source of truth.
 */
export async function markOrderMetafieldVouchersRefunded(
  shop: string,
  accessToken: string,
  orderId: string,
  codes: string[],
  refundedAt: string
): Promise<void> {
  const res = await shopifyFetch(
    shop,
    accessToken,
    `orders/${orderId}/metafields.json?namespace=xw_experience&key=vouchers`
  );
  if (!res.ok) throw new Error(`Order metafield read failed: ${res.status}`);
  const data = await res.json();
  const metafield = (data.metafields ?? [])[0] as { id: number; value: string } | undefined;
  if (!metafield) return;

  const vouchers = JSON.parse(metafield.value) as { code: string; status: string; refunded_at?: string }[];
  const updated = vouchers.map((v) =>
    codes.includes(v.code) ? { ...v, status: "refunded", refunded_at: refundedAt } : v
  );

  const putRes = await shopifyFetch(
    shop,
    accessToken,
    `orders/${orderId}/metafields/${metafield.id}.json`,
    {
      method: "PUT",
      body: JSON.stringify({
        metafield: { id: metafield.id, type: "json", value: JSON.stringify(updated) },
      }),
    }
  );
  if (!putRes.ok) {
    throw new Error(`Order metafield update failed: ${putRes.status} ${await putRes.text()}`);
  }
}

// ── Registrazione webhook ─────────────────────────────────────────────────────

export async function registerWebhook(
  shop: string,
  accessToken: string,
  topic: string,
  address: string
): Promise<void> {
  const res = await shopifyFetch(shop, accessToken, "webhooks.json", {
    method: "POST",
    body: JSON.stringify({
      webhook: { topic, address, format: "json" },
    }),
  });
  // Prima la risposta era ignorata: un topic non valido ("orders/refunded",
  // che non esiste) falliva senza lasciare traccia. 422 con subscription
  // gia' esistente per topic+address e' atteso alle reinstallazioni.
  if (!res.ok) {
    console.error(`Registrazione webhook ${topic} -> ${address} fallita: ${res.status} ${await res.text()}`);
  }
}
