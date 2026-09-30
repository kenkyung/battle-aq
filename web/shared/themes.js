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
  de_aq_dust2: null,   // filled from de_aq_dust below
  cs_aq_office: {
    mats: {
      floor:    { tex: 'snow',         tile: 256 },
      carpet:   { tex: 'carpet',       tile: 128 },
      wall:     { tex: 'drywall',      tile: 128 },
      concrete: { tex: 'concrete',     tile: 192 },
      ceiling:  { tex: 'ceiling_tile', tile: 64 },
      wood:     { tex: 'planks_dark',  tile: 96 },
      metal:    { tex: 'metal_plate',  tile: 128 },
      cover:    { tex: 'crate',        tile: 0 },
      foliage:  { tex: 'hedge',        tile: 96 },
      accent:   { tex: 'concrete',     tile: 256 },
    },
    sunDir: [0.3, 0.75, 0.55], sunColor: 'e8eef8', sunStrength: 2.2,
    skyStrength: 1.4, clouds: 0.85, skyline: 'town',
  },
  cs_aq_assault: {
    mats: {
      floor:     { tex: 'asphalt',         tile: 256 },
      concrete:  { tex: 'concrete',        tile: 192 },
      wall:      { tex: 'corrugated',      tile: 128 },
      roof:      { tex: 'corrugated',      tile: 128 },
      ceiling:   { tex: 'ceiling_tile',    tile: 64 },
      office:    { tex: 'drywall',         tile: 128 },
      container: { tex: 'container_paint', tile: 128 },
      metal:     { tex: 'metal_plate',     tile: 128 },
      cover:     { tex: 'crate',           tile: 0 },
      wood:      { tex: 'planks',          tile: 96 },
      accent:    { tex: 'concrete',        tile: 256 },
    },
    sunDir: [-0.45, 0.8, 0.4], sunColor: 'fff0d8', sunStrength: 3.6,
    skyStrength: 1.0, clouds: 0.45, skyline: 'town',
  },
  cs_aq_italy: {
    mats: {
      floor:   { tex: 'cobbles',      tile: 192 },
      wall:    { tex: 'plaster',      tile: 256 },
      house:   { tex: 'plaster',      tile: 192 },
      accent:  { tex: 'roof_tiles',   tile: 96 },
      wood:    { tex: 'planks',       tile: 96 },
      cover:   { tex: 'crate',        tile: 0 },
      stone:   { tex: 'dust_bigblock', tile: 128 },
      metal:   { tex: 'metal_plate',  tile: 128 },
      foliage: { tex: 'hedge',        tile: 96 },
      ceiling: { tex: 'planks_dark',  tile: 96 },
      water:   { tex: 'water',        tile: 256 },
    },
    sunDir: [0.5, 0.78, -0.35], sunColor: 'fff0d0', sunStrength: 4.0,
    skyStrength: 0.95, clouds: 0.3, skyline: 'town',
  },
  fy_pool_day2: {
    mats: {
      floor:   { tex: 'pool_tile',    tile: 128 },
      deck:    { tex: 'concrete',     tile: 192 },
      wall:    { tex: 'drywall',      tile: 192 },
      accent:  { tex: 'roof_tiles',   tile: 96 },
      grass:   { tex: 'grass',        tile: 256 },
      foliage: { tex: 'hedge',        tile: 96 },
      wood:    { tex: 'planks',       tile: 96 },
      cover:   { tex: 'crate',        tile: 0 },
      metal:   { tex: 'metal_plate',  tile: 128 },
      water:   { tex: 'pool_water',   tile: 256 },
    },
    sunDir: [0.45, 0.85, 0.3], sunColor: 'fff6e4', sunStrength: 4.2,
    skyStrength: 1.1, clouds: 0.25, skyline: 'town',
  },
  fy_snow: {
    mats: {
      floor:    { tex: 'snow',         tile: 256 },
      wall:     { tex: 'concrete',     tile: 192 },
      concrete: { tex: 'concrete',     tile: 192 },
      accent:   { tex: 'planks_dark',  tile: 96 },
      wood:     { tex: 'planks_dark',  tile: 96 },
      cover:    { tex: 'crate',        tile: 0 },
      metal:    { tex: 'metal_plate',  tile: 128 },
    },
    sunDir: [0.3, 0.7, 0.6], sunColor: 'e8eef8', sunStrength: 2.0,
    skyStrength: 1.5, clouds: 0.9, skyline: 'town',
  },
  fy_aq_rooftops: {
    mats: {
      floor:  { tex: 'asphalt',     tile: 256 },
      wall:   { tex: 'brick_red',   tile: 128 },
      house:  { tex: 'plaster',     tile: 192 },
      roof:   { tex: 'concrete',    tile: 192 },
      accent: { tex: 'brick_red',   tile: 96 },
      wood:   { tex: 'planks',      tile: 96 },
      cover:  { tex: 'crate',       tile: 0 },
      metal:  { tex: 'metal_plate', tile: 128 },
    },
    sunDir: [0.75, 0.38, 0.35], sunColor: 'ffc88e', sunStrength: 3.4,
    skyStrength: 0.9, clouds: 0.4, skyline: 'town',
  },
  de_aq_nuke: {
    mats: {
      floor:     { tex: 'asphalt',         tile: 256 },
      wall:      { tex: 'concrete',        tile: 192 },
      concrete:  { tex: 'concrete',        tile: 192 },
      roof:      { tex: 'corrugated',      tile: 128 },
      metal:     { tex: 'metal_plate',     tile: 128 },
      container: { tex: 'container_paint', tile: 128 },
      accent:    { tex: 'metal_plate',     tile: 128 },
      cover:     { tex: 'crate',           tile: 0 },
      wood:      { tex: 'planks',          tile: 96 },
    },
    sunDir: [0.5, 0.8, -0.35], sunColor: 'fff4e4', sunStrength: 3.6,
    skyStrength: 1.1, clouds: 0.55, skyline: 'town',
  },
  de_aq_train: {
    mats: {
      floor:     { tex: 'asphalt',         tile: 256 },
      wall:      { tex: 'brick_red',       tile: 128 },
      concrete:  { tex: 'concrete',        tile: 192 },
      container: { tex: 'container_paint', tile: 128 },
      rust:      { tex: 'corrugated',      tile: 128 },
      metal:     { tex: 'metal_plate',     tile: 128 },
      accent:    { tex: 'concrete',        tile: 256 },
      cover:     { tex: 'crate',           tile: 0 },
      wood:      { tex: 'planks',          tile: 96 },
    },
    sunDir: [-0.4, 0.75, 0.5], sunColor: 'fff0dc', sunStrength: 3.4,
    skyStrength: 1.0, clouds: 0.6, skyline: 'town',
  },
};

THEMES.de_aq_dust2 = THEMES.de_aq_dust;

export function themeFor(mapId) { return THEMES[mapId] || THEMES.de_aq_dust; }
