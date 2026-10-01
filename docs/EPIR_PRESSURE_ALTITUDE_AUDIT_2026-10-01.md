# EPIR pressure-altitude / elevation audit — 2026-10-01

## Production airport elevation

The fixed aerodrome elevation used by the pressure-altitude module is:

- EPIR: 276 ft AMSL
- EPIR: 84.1248 m AMSL

The authoritative project metadata is `station-metadata.json` (`EPIR.elevation_ft_amsl` and `EPIR.elevation_m_amsl`).

## Pressure-altitude calculation

`pressure-altitude.js` uses the ISA tropospheric barometric relation with:

- standard sea-level pressure: 1013.25 hPa
- standard sea-level temperature: 288.15 K
- lapse rate: 0.0065 K/m
- gravity: 9.80665 m/s²
- dry-air gas constant: 287.05287 J/(kg·K)

QNH is first reduced to station pressure at the fixed EPIR elevation under ISA, then that pressure is converted to altitude in the standard 1013.25 hPa atmosphere. This avoids the approximate ft/hPa shortcut. At QNH 1013.25 hPa the calculated pressure altitude is exactly the aerodrome elevation (276 ft, within floating-point precision).

## Values intentionally not changed

The following active runtime uses of `elevation` are model/grid terrain height and are not EPIR aerodrome elevation:

- `index.html`: `core.elevation` / `prof.elevation` stored as `ds.elevation`; used to convert model geopotential profiles to AGL.
- `index.html`: consensus and single-model cloud profiles use `ds.elevation`; the 90 m value is only a missing-model-terrain fallback.
- `fog-engine.js`: `ds.elevation` is used as model terrain for the cloud/profile diagnostic; its 90 m fallback remains unchanged.
- `taf-app-v25.js`: per-model cloud profiles use `ds.elevation` when deriving AGL cloud information; its 90 m fallback remains unchanged.

Changing those values to 84.1248 m would mix real aerodrome elevation with numerical-model orography and would corrupt AGL cloud calculations.

## UI integration

The production pressure-altitude panel is loaded only on `index.html`. It is inserted immediately after `#sectionInfo`, so the selected-value frame remains directly below the meteogram and the pressure-altitude panel follows it at full available width.
