const path = require('path');
const config = require('config');
const mapnik = require('mapnik');
const { rename, mkdir, unlink, stat } = require('fs').promises;
const { mercSrs } = require('./projections');
const { zoomDenoms } = require('./styleBuilder');
const { tile2key } = require('./tileCalc');
const { dirtyTiles } = require('./dirtyTilesRegister');
const { pool } = require('./mapnikPool');

const forceTileRendering = config.get('forceTileRendering');
const rerenderOlderThanMs = config.get('rerenderOlderThanMs');

const tilesDir = path.resolve(__dirname, '..', config.get('dirs.tiles'));

const merc = new mapnik.Projection(mercSrs);

module.exports = { renderTile };

async function renderTile(zoom, x, y, prerender) {
  const frags = [tilesDir, zoom.toString(10), x.toString(10)];

  const p = path.join(...frags, `${y}`);
  if (forceTileRendering || await shouldRender(p, prerender, { zoom, x, y })) {
    console.log(`${prerender ? 'Pre-rendering' : 'Rendering'} tile: ${zoom}/${x}/${y}`);
    const map = await pool.acquire(prerender ? 1 : 0);
    map.zoomToBox(merc.forward([...transformCoords(zoom, x, y + 1), ...transformCoords(zoom, x + 1, y)]));

    await mkdir(path.join(...frags), { recursive: true });
    const tmpName = `${p}_tmp.png`;
    await map.renderFileAsync(tmpName, { format: 'png', buffer_size: 256, scale: 1 });
    await Promise.all([
      rename(tmpName, `${p}.png`).catch((err) => {
        console.error('Error renaming file:', err);
      }),
      (async () => {
        try {
          await unlink(`${p}.dirty`);
        } catch (_) {
          // ignore
        }
        dirtyTiles.delete(tile2key({ zoom, x, y }));
      })(),
    ]);

    pool.release(map);
  }

  return `${p}.png`;
}

async function shouldRender(p, prerender, tile) {
  try {
    const s = await stat(`${p}.png`);
    if (!prerender) {
      return false;
    }
    if (rerenderOlderThanMs && s.mtimeMs < rerenderOlderThanMs || dirtyTiles.has(tile2key(tile))) {
      return true;
    }
  } catch (err) {
    return true;
  }

  return false;
}

// scale: my screen is 96 dpi, pdf is 72 dpi; 72 / 96 = 0.75
module.exports.toPdf = async (destFile, xml, zoom, bbox0, scale = 1, width) => {
  const bbox = merc.forward(bbox0);
  const q = 0.00310668945 * Math.pow(2, zoom); // 25.45 for zoom 13
  const map = new mapnik.Map(
    width || (bbox[2] - bbox[0]) / q,
    width ? (bbox[3] - bbox[1]) / (bbox[2] - bbox[0]) * width : (bbox[3] - bbox[1]) / q,
  );
  await map.fromStringAsync(xml);
  map.zoomToBox(bbox);
  await map.renderFileAsync(destFile, { format: 'pdf', buffer_size: 256, scale_denominator: zoomDenoms[zoom], scale });
};

function transformCoords(zoom, xtile, ytile) {
  const n = Math.pow(2, zoom);
  const lon_deg = xtile / n * 360.0 - 180.0;
  const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * ytile / n)));
  const lat_deg = lat_rad * 180.0 / Math.PI;
  return [lon_deg, lat_deg];
}
