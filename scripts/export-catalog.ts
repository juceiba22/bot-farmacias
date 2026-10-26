/**
 * Empaqueta data/catalog.db en seed/catalog.json.gz, un archivo chico que se versiona con el código
 * y que el servidor importa solo la primera vez que arranca sin catálogo (por ejemplo, en Railway).
 *
 *   npm run catalog:export
 */
import { env } from '../src/config.ts';
import { exportSeed } from '../src/catalog-seed.ts';
import { statSync } from 'node:fs';

const count = exportSeed(env.catalogFile, env.catalogSeed);
const kb = Math.round(statSync(env.catalogSeed).size / 1024);
console.log(`${count} productos → ${env.catalogSeed} (${kb} KB)`);
