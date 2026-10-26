/**
 * Arma un catálogo de DEMOSTRACIÓN a partir de la API pública de catálogo de Farmacity (plataforma VTEX).
 *
 * Es deliberadamente chico y educado:
 *  - solo categorías de farmacia, con un tope por categoría (por defecto 200 productos);
 *  - una consulta por segundo, con un User-Agent que dice qué es;
 *  - se detiene si el sitio responde 403 (no se intenta esquivar ningún bloqueo);
 *  - solo toca endpoints que su robots.txt no excluye.
 *
 * Los precios son una foto del momento y NO son los de ninguna farmacia en particular: sirven para la demo, no para vender.
 *
 *   npm run catalog:scrape                  # carga por defecto
 *   PER_CATEGORY=50 npm run catalog:scrape  # una muestra más chica
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openCatalog } from '../src/catalog.ts';
import type { CatalogProduct, SaleType } from '../src/catalog.ts';
import { env } from '../src/config.ts';

const BASE = 'https://www.farmacity.com';
const USER_AGENT = 'farmacia-bot-demo/0.1 (muestra de catalogo para una demo; contacto: productoracontenidos.hur@gmail.com)';
const DELAY_MS = 1000;
const PAGE_SIZE = 50;
const PER_CATEGORY = Number(process.env.PER_CATEGORY) || 200;

// id de categoría de VTEX → nombre (ver /api/catalog_system/pub/category/tree/2)
const CATEGORIES: [number, string][] = [
  [979, 'Medicamentos Venta Libre'],
  [1060, 'Venta Bajo Receta'],
  [199, 'Farmacia'],
  [116, 'Dermocosmética'],
  [93, 'Cuidado de la Piel'],
  [92, 'Cuidado Personal'],
  [204, 'Electrosalud'],
  [3, 'Bebés'],
  [248, 'Nutrición y Deportes'],
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class BlockedError extends Error {}

async function getJson(url: string): Promise<any[]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 403) throw new BlockedError('El sitio respondió 403: se corta acá y no se insiste.');
    if (res.status === 404) return [];
    if (res.ok) return (await res.json()) as any[];
    if (res.status === 429 || res.status >= 500) {
      const wait = 5000 * attempt;
      console.warn(`  HTTP ${res.status}, reintento en ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} en ${url}`);
  }
  throw new Error(`Demasiados reintentos en ${url}`);
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
};

function htmlToText(html: string, max = 600): string {
  const text = html
    .replace(/<(br|\/p|\/h\d|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const list = (v: unknown): string | null => {
  const items = Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
  return items.length ? items.join(', ') : null;
};

function saleType(categories: string[], description: string): SaleType {
  const haystack = `${categories.join(' ')} ${description}`.toLowerCase();
  if (haystack.includes('bajo receta')) return 'receta';
  if (haystack.includes('venta libre')) return 'libre';
  return 'otro';
}

function toProduct(p: any, scrapedAt: string): CatalogProduct | undefined {
  const item = p.items?.[0];
  const offer = item?.sellers?.[0]?.commertialOffer;
  if (!p.productId || !p.productName || !offer?.IsAvailable) return undefined;

  const categories: string[] = p.categories ?? [];
  // La categoría más específica es la primera de la lista de VTEX.
  const category = (categories[0] ?? '').split('/').filter(Boolean).join(' > ') || 'Sin categoría';
  const description = htmlToText(String(p.description ?? ''));

  return {
    id: String(p.productId),
    name: String(p.productName).trim(),
    brand: p.brand ? String(p.brand) : null,
    category,
    categories: categories.map((c) => c.split('/').filter(Boolean).join(' > ')).join(' | '),
    ingredients: list(p['Drogas']),
    presentation: list(p['Presentación']),
    dose: list(p['Dosis']),
    sale_type: saleType(categories, description),
    ean: item?.ean ? String(item.ean) : null,
    price: typeof offer.Price === 'number' ? offer.Price : null,
    list_price: typeof offer.ListPrice === 'number' ? offer.ListPrice : null,
    description,
    url: String(p.link ?? `${BASE}/${p.linkText}/p`),
    image_url: item?.images?.[0]?.imageUrl ?? null,
    scraped_at: scrapedAt,
  };
}

async function main() {
  const file = process.env.CATALOG_DB || join(env.dataDir, 'catalog.db');
  mkdirSync(dirname(file), { recursive: true });
  const catalog = openCatalog(file);
  const scrapedAt = new Date().toISOString();
  const seen = new Set<string>();

  console.log(`Catálogo de demostración → ${file}`);
  console.log(`Tope: ${PER_CATEGORY} productos por categoría, ${CATEGORIES.length} categorías.\n`);

  try {
    for (const [id, name] of CATEGORIES) {
      let kept = 0;
      for (let from = 0; kept < PER_CATEGORY; from += PAGE_SIZE) {
        const url = `${BASE}/api/catalog_system/pub/products/search?fq=C:/${id}/&_from=${from}&_to=${from + PAGE_SIZE - 1}`;
        const page = await getJson(url);
        for (const raw of page) {
          const product = toProduct(raw, scrapedAt);
          if (!product || seen.has(product.id)) continue;
          seen.add(product.id);
          catalog.upsert(product);
          if (++kept >= PER_CATEGORY) break;
        }
        await sleep(DELAY_MS);
        if (page.length < PAGE_SIZE) break;
      }
      console.log(`  ${name.padEnd(28)} ${kept} productos`);
    }
  } catch (err) {
    if (err instanceof BlockedError) console.error(`\n${err.message}`);
    else throw err;
  } finally {
    catalog.reindex();
  }

  console.log(`\nListo: ${catalog.count()} productos únicos en el catálogo.`);
  catalog.close();
}

await main();
