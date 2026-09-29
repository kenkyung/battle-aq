// Look of each map: which surface texture paints each palette material, how
// many world units one texture repeat covers, and the lighting. Read by the
// browser (runtime lights for players and weapons) AND by the Blender build
// (tools/export-maps.mjs -> art/blender/build_maps.py), so the baked
// lightmaps and the live lighting agree on where the sun is.
//
// surface ids refer to art/blender/build_textures.py (web/public/assets/tex/<id>.jpg)

export const THEMES = {
  de_aq_dust: {
    mats: {
      floor:  { tex: 'dust_sand',      tile: 256 },
      wall:   { tex: 'dust_sandstone', tile: 128 },
      accent: { tex: 'dust_bigblock',  tile: 192 },
      cover:  { tex: 'crate',          tile: 0 },
      metal:  { tex: 'metal_plate',    tile: 128 },
      wood:   { tex: 'planks',         tile: 128 },
    },
    sunDir: [0.55, 0.85, 0.35], sunColor: 'fff1d6', sunStrength: 4.0,
    skyStrength: 1.0, clouds: 0.35, skyline: 'town',
  },
  de_aq_inferno: {
    mats: {
      floor:  { tex: 'cobbles',       tile: 192 },
      wall:   { tex: 'plaster',       tile: 256 },
      accent: { tex: 'brick_red',     tile: 128 },
      cover:  { tex: 'crate',         tile: 0 },
      metal:  { tex: 'metal_plate',   tile: 128 },
      wood:   { tex: 'planks_dark',   tile: 128 },
    },
    sunDir: [-0.5, 0.7, 0.5], sunColor: 'ffd9a8', sunStrength: 3.6,
    skyStrength: 0.9, clouds: 0.5, skyline: 'town',
  },
  de_aq_aztec: {
    mats: {
      floor:   { tex: 'jungle_ground', tile: 256 },
      wall:    { tex: 'aztec_stone',   tile: 128 },
      stone:   { tex: 'aztec_carved',  tile: 128 },
      accent:  { tex: 'aztec_stone',   tile: 192 },
      cover:   { tex: 'crate',         tile: 0 },
      foliage: { tex: 'hedge',         tile: 96 },
      wood:    { tex: 'planks',        tile: 128 },
      metal:   { tex: 'metal_plate',   tile: 128 },
      water:   { tex: 'water',         tile: 256 },
    },
    sunDir: [0.4, 0.8, -0.45], sunColor: 'fff4e0', sunStrength: 3.4,
    skyStrength: 1.1, clouds: 0.65, skyline: 'jungle',
  },
};

export function themeFor(mapId) { return THEMES[mapId] || THEMES.de_aq_dust; }
