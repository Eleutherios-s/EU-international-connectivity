import { useEffect, useMemo } from "react";
import styles from "./Map.module.css";

import L from "leaflet";
import { MapContainer, TileLayer, CircleMarker, Popup, GeoJSON, useMap } from "react-leaflet";

import type { CityIndexItem } from "../models/CityData";
import type { GeoJSONFeature } from "../models/Connections";
import type { GeoJSONFeatureCollectionPoint } from "../models/Isochrone";
import type { CrossborderRoutesResponse } from "../models/Crossborder";

type GeoJSONFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
  meta?: any;
};

const EUROPE_CENTER: [number, number] = [51.0, 10.0];
const EUROPE_ZOOM = 4;

// ===== line aesthetics =====
const LINE = {
  // pastel-ish, low saturation, higher lightness
  domestic: "#5AA9E6",     // soft blue
  crossborder: "#C65A5A",  // soft red
  ab: "#6C757D",           // neutral gray-blue for AB
  weightA: 1.6,
  weightAB: 2.0,
  opacity: 0.75,
  opacityAB: 0.85,
};


// ===== WebMercator helpers (EPSG:3857) =====
const R = 6378137;
function lonLatToMercator(lon: number, lat: number): [number, number] {
  const x = (lon * Math.PI * R) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

function FitToSelection({ cityA, cityB }: { cityA: CityIndexItem | null; cityB: CityIndexItem | null }) {
  const map = useMap();

  useEffect(() => {
    if (cityA && cityB) {
      const bounds = [
        [cityA.center.lat, cityA.center.lon],
        [cityB.center.lat, cityB.center.lon],
      ] as any;
      map.fitBounds(bounds, { padding: [40, 40] });
    } else if (cityA && !cityB) {
      map.setView([cityA.center.lat, cityA.center.lon], 7);
    }
  }, [cityA?.city_id, cityB?.city_id]);

  return null;
}

function LegendControl({
  maxTime = 720,          // minutes (still minutes internally)
  band = 30,              // minutes
  position = "bottomright",
  ticks = 6,
  showTickMarks = true,
}: {
  maxTime?: number;
  band?: number;
  position?: L.ControlPosition;
  ticks?: number;
  showTickMarks?: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    const ctl = L.control({ position });

    ctl.onAdd = () => {
      const div = L.DomUtil.create("div", "leaflet-control legend-control") as HTMLDivElement;
      div.style.background = "rgba(255,255,255,0.92)";
      div.style.border = "1px solid rgba(0,0,0,0.15)";
      div.style.borderRadius = "10px";
      div.style.padding = "10px 10px";
      div.style.boxShadow = "0 6px 18px rgba(0,0,0,0.12)";
      div.style.fontSize = "12px";
      div.style.lineHeight = "1.2";
      div.style.minWidth = "240px";

      const n = Math.max(2, ticks);
      const valuesMin: number[] = [];
      for (let i = 0; i <= n; i++) valuesMin.push(Math.round((maxTime * i) / n));

      // Same color mapping as heatmap (gamma 0.55)
      const stops = valuesMin
        .map((tMin) => {
          const tt0 = Math.max(0, Math.min(1, tMin / maxTime));
          const tt = Math.pow(tt0, 0.55);
          const hue = 120 - 120 * tt;
          return `hsl(${hue}, 85%, 50%)`;
        })
        .join(",");

      const tickMarksHtml = showTickMarks
        ? `
        <div style="position:relative; height:10px; margin-top:4px;">
          ${valuesMin
            .map((_, i) => {
              const left = (i / n) * 100;
              return `<div style="
                position:absolute;
                left:${left}%;
                top:0;
                transform: translateX(-0.5px);
                width:1px;
                height:8px;
                background: rgba(0,0,0,0.25);
              "></div>`;
            })
            .join("")}
        </div>
      `
        : "";

      // format minutes -> hours with 1 decimal if needed
      const fmtHours = (min: number) => {
        const h = min / 60;
        // show integer for clean numbers, else 1 decimal
        return Math.abs(h - Math.round(h)) < 1e-9 ? `${Math.round(h)}` : h.toFixed(1);
      };

      const labelsHtml = `
        <div style="display:flex; justify-content:space-between; margin-top:2px; opacity:0.95;">
          ${valuesMin.map((v) => `<span>${fmtHours(v)}</span>`).join("")}
        </div>
      `;

      div.innerHTML = `
        <div style="font-weight:800; margin-bottom:6px;">Travel time (h)</div>

        <div style="
          height:12px;
          border-radius:7px;
          background: linear-gradient(to right, ${stops});
          border: 1px solid rgba(0,0,0,0.12);
        "></div>

        ${tickMarksHtml}
        ${labelsHtml}

      `;

      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };

    ctl.addTo(map);
    return () => ctl.remove();
  }, [map, maxTime, band, position, ticks, showTickMarks]);

  return null;
}


function cityRadiusOriginal(c: CityIndexItem): number {
  const base = 4;
  const bump = Math.min(10, Math.sqrt(Math.max(0, c.trip_count ?? 0)) / 6);
  return base + bump;
}

function overviewFillColor(c: CityIndexItem): string {
  const v = Math.max(0, Number(c.trip_count ?? 0));
  const t = clamp(Math.log10(v + 1) / 4, 0, 1);
  const hue = 210 - 190 * t;
  return `hsl(${hue}, 85%, 55%)`;
}

/**
 * ===== HeatmapOverlay
 * Policy:
 * - Always try to render something if fc has >= 1 point.
 * - When points are "many enough", use nearest-neighbor raster (fast, stable).
 * - When points are few, draw radial "blob circles".
 */

function buildConcentricCircleBands(
  fc: GeoJSONFeatureCollectionPoint,
  opts?: { binCount?: number; maxNonOriginPoints?: number }
): L.LayerGroup | null {
  const binCount = opts?.binCount ?? 3;
  const maxNonOriginPoints = opts?.maxNonOriginPoints ?? 5;

  const ptsRaw: { lon: number; lat: number; t: number }[] = [];
  for (const f of fc.features ?? []) {
    const g: any = f.geometry;
    if (!g || g.type !== "Point") continue;
    const [lon, lat] = g.coordinates as [number, number];
    const t = Number((f.properties as any)?.travel_time_min ?? NaN);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(t)) continue;
    ptsRaw.push({ lon, lat, t });
  }
  if (ptsRaw.length < 2) return null;

  const origin = ptsRaw.find((p) => p.t === 0) ?? ptsRaw[0];
  const nonOrigin = ptsRaw.filter((p) => p.t > 0);

  if (nonOrigin.length === 0) return null;
  if (nonOrigin.length > maxNonOriginPoints) return null;

  // Use the farthest destination (by geographic distance) as the outer radius reference.
  const [ox, oy] = lonLatToMercator(origin.lon, origin.lat);
  let maxR = 0;
  let maxT = 0;
  for (const p of nonOrigin) {
    const [x, y] = lonLatToMercator(p.lon, p.lat);
    const dx = x - ox;
    const dy = y - oy;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r > maxR) maxR = r;
    if (p.t > maxT) maxT = p.t;
  }
  if (maxR <= 0) return null;
  if (maxT <= 0) maxT = Math.max(...nonOrigin.map((p) => p.t));

  // Build equally spaced time bins up to maxT (minutes).
  const bins: number[] = [];
  for (let i = 1; i <= binCount; i++) {
    bins.push((maxT * i) / binCount);
  }

  function binToColor(t: number): string {
    // Green (fast) -> Red (slow)
    const tt = clamp(t / maxT, 0, 1);
    const hue = 120 - 120 * tt;
    // Convert HSL to RGB (s=0.85, l=0.5)
    const s = 0.85, l = 0.5;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = hue / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r1 = 0, g1 = 0, b1 = 0;
    if (0 <= hp && hp < 1) [r1, g1, b1] = [c, x, 0];
    else if (1 <= hp && hp < 2) [r1, g1, b1] = [x, c, 0];
    else if (2 <= hp && hp < 3) [r1, g1, b1] = [0, c, x];
    else if (3 <= hp && hp < 4) [r1, g1, b1] = [0, x, c];
    else if (4 <= hp && hp < 5) [r1, g1, b1] = [x, 0, c];
    else if (5 <= hp && hp < 6) [r1, g1, b1] = [c, 0, x];
    const m = l - c / 2;
    const r = Math.round((r1 + m) * 255);
    const g = Math.round((g1 + m) * 255);
    const b = Math.round((b1 + m) * 255);
    return `rgba(${r},${g},${b},0.28)`;
  }

  const group = L.layerGroup();

  // Draw outer -> inner so inner rings stay visible.
  for (let i = bins.length - 1; i >= 0; i--) {
    const t = bins[i];
    const r = maxR * (t / maxT);
    group.addLayer(
      L.circle([origin.lat, origin.lon], {
        radius: r,
        stroke: false,
        fill: true,
        fillOpacity: 1.0,
        fillColor: binToColor(t),
        interactive: false,
      })
    );
  }

  return group;
}

function buildIsoHeatmapOverlay(
  fc: GeoJSONFeatureCollectionPoint,
  opts?: {
    nx?: number;
    ny?: number;
    sampleMax?: number;

    maxTime?: number;      // minutes
    fadeStart?: number;    // minutes (start fading near outer ring)

    // Interpolation controls
    idwK?: number;         // use K nearest points (small K keeps it fast)
    idwPower?: number;     // IDW power, typically 1.5~3
    maxDistFactor?: number; // how far we still "trust" interpolation (as fraction of bbox diagonal)
    blurPasses?: number;   // how many box-blur passes on the value field (1~3)
    alphaBoost?: number;   // deepen alpha but still transparent, 0.0~1.0
    overlayOpacity?: number; // overall overlay opacity
    singlePointBufferM?: number;

    // Banding (isochrone rings)
    bandIntervalMin?: number;

    // Optional: Polygon for clipping (e.g. isochrone shapes)
    clipPolygons?: GeoJSONFeatureCollection | null;
  },
): { dataUrl: string; bounds: L.LatLngBounds; opacity: number } | null {
  const nx = opts?.nx ?? 240;
  const ny = opts?.ny ?? 240;

  // IMPORTANT: keep sample small enough (front-end performance)
  // IDW complexity ~ nx*ny*sampleMax
  const sampleMax = opts?.sampleMax ?? 900;

  const maxTime = opts?.maxTime ?? 240;
  const fadeStart = opts?.fadeStart ?? 180;

  const idwK = opts?.idwK ?? 10;
  const idwPower = opts?.idwPower ?? 2.2;
  const maxDistFactor = opts?.maxDistFactor ?? 0.75; 
  const blurPasses = opts?.blurPasses ?? 2;

  const alphaBoost = opts?.alphaBoost ?? 0.35; 
  const overlayOpacity = opts?.overlayOpacity ?? 0.78; 

  const singlePointBufferM = opts?.singlePointBufferM ?? 220000; // ~220km
  const bandIntervalMin = opts?.bandIntervalMin ?? 15;

  const clipPolygons = opts?.clipPolygons;

  // ----- collect points -----
  const ptsRaw: { x: number; y: number; v: number }[] = [];
  for (const f of fc.features ?? []) {
    const g: any = f.geometry;
    if (!g || g.type !== "Point") continue;

    const [lon, lat] = g.coordinates as [number, number];
    const v = Number((f.properties as any)?.travel_time_min ?? NaN);
    if (!Number.isFinite(v)) continue;

    const [x, y] = lonLatToMercator(lon, lat);
    ptsRaw.push({ x, y, v });
  }
  if (ptsRaw.length === 0) return null;

  // ----- downsample if too many points -----
  let pts = ptsRaw;
  if (ptsRaw.length > sampleMax) {
    const step = Math.ceil(ptsRaw.length / sampleMax);
    pts = ptsRaw.filter((_, i) => i % step === 0);
  }

  // ----- bounds in mercator -----
  const originPt = pts.find((p) => p.v === 0) ?? pts[0];

  let maxR = 0;
  for (const p of pts) {
    const dx0 = p.x - originPt.x;
    const dy0 = p.y - originPt.y;
    const r = Math.sqrt(dx0 * dx0 + dy0 * dy0);
    if (r > maxR) maxR = r;
  }

  if (!(maxR > 0)) maxR = singlePointBufferM;

  // Add padding to ensure the full polygon fits if it extends beyond points
  const padFactor = 1.18;
  const minX = originPt.x - maxR * padFactor;
  const maxX = originPt.x + maxR * padFactor;
  const minY = originPt.y - maxR * padFactor;
  const maxY = originPt.y + maxR * padFactor;

  const dx = maxX - minX;
  const dy = maxY - minY;

  const diag = Math.sqrt(dx * dx + dy * dy);
  const maxDist = diag * maxDistFactor;
  const maxDist2 = maxDist * maxDist;

  // Calculate circular fallback params just in case no polygons provided
  const outerR = maxR * padFactor;
  const outerR2 = outerR * outerR;
  const radialFeather = 0.12; 
  const innerR = outerR * (1 - radialFeather);
  const innerR2 = innerR * innerR;

  const canvas = document.createElement("canvas");
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  // =========================================================
  // STEP 1: PRE-DRAW POLYGON MASK (Clipping Layer)
  // =========================================================
  let maskPixels: Uint8ClampedArray | null = null;

  if (clipPolygons && clipPolygons.features && clipPolygons.features.length > 0) {
    // Fill background with transparent
    ctx.clearRect(0, 0, nx, ny);
    
    // Feathering for the edge
    ctx.filter = 'blur(12px)'; 
    ctx.fillStyle = 'black'; // Color doesn't matter, we use Alpha

    const drawRing = (ring: any[]) => {
      ctx.beginPath();
      let first = true;
      for (const pos of ring) {
        const [lon, lat] = pos;
        const [mx, my] = lonLatToMercator(lon, lat);
        
        // Map Mercator to Canvas X/Y
        // NOTE: Standard Canvas Y is Top-Down (0 at top).
        // Our Grid loop later assumes y = minY + ... which is bottom-up in math,
        // but let's match the visual output.
        // If we want the image to map correctly to Leaflet, row 0 is North (Top).
        // Mercator Y increases North.
        // So Canvas Y = 0 should correspond to maxY.
        //    Canvas Y = ny should correspond to minY.
        
        const px = ((mx - minX) / dx) * nx;
        const py = ((maxY - my) / dy) * ny; // Invert Y for canvas drawing

        if (first) {
          ctx.moveTo(px, py);
          first = false;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.closePath();
      ctx.fill();
    };

    for (const f of clipPolygons.features) {
      const geom: any = f.geometry;
      if (!geom) continue;

      if (geom.type === "Polygon") {
        // Outer ring only for simple mask (ignoring holes for simplicity or handling them if needed)
        if (geom.coordinates && geom.coordinates.length > 0) {
           drawRing(geom.coordinates[0]);
        }
      } else if (geom.type === "MultiPolygon") {
        for (const poly of geom.coordinates) {
          if (poly && poly.length > 0) {
            drawRing(poly[0]);
          }
        }
      }
    }
    
    // Extract the alpha mask
    maskPixels = ctx.getImageData(0, 0, nx, ny).data;
    
    // Reset canvas for actual Heatmap
    ctx.filter = 'none';
    ctx.clearRect(0, 0, nx, ny);
  }

  // =========================================================
  // STEP 2: IDW CALCULATION
  // =========================================================

  // Helper: map value to color
  function timeToRGBA(v: number): [number, number, number, number] {
    const t = clamp(v / maxTime, 0, 1);
    const hue = 120 - 120 * t;

    const s = 0.85;
    const l = 0.5;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = hue / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));

    let r1 = 0, g1 = 0, b1 = 0;
    if (0 <= hp && hp < 1) [r1, g1, b1] = [c, x, 0];
    else if (1 <= hp && hp < 2) [r1, g1, b1] = [x, c, 0];
    else if (2 <= hp && hp < 3) [r1, g1, b1] = [0, c, x];
    else if (3 <= hp && hp < 4) [r1, g1, b1] = [0, x, c];
    else if (4 <= hp && hp < 5) [r1, g1, b1] = [x, 0, c];
    else if (5 <= hp && hp < 6) [r1, g1, b1] = [c, 0, x];

    const m = l - c / 2;
    const r = Math.round(255 * (r1 + m));
    const g = Math.round(255 * (g1 + m));
    const b = Math.round(255 * (b1 + m));

    // alpha: stronger overall, still transparent
    const edgeFade = v <= fadeStart ? 1 : clamp(1 - (v - fadeStart) / (maxTime - fadeStart), 0, 1);
    const base = 0.55 + alphaBoost;
    const a = Math.round(255 * clamp(base, 0, 0.95) * edgeFade);
    return [r, g, b, a];
  }

  const N = nx * ny;
  const vField = new Float32Array(N);
  const aField = new Float32Array(N); 
  const eps = 1e-6;

  function updateKNN(bestD2: number[], bestV: number[], d2: number, v: number) {
    let worstIdx = 0;
    let worstVal = bestD2[0];
    for (let i = 1; i < bestD2.length; i++) {
      if (bestD2[i] > worstVal) {
        worstVal = bestD2[i];
        worstIdx = i;
      }
    }
    if (d2 < worstVal) {
      bestD2[worstIdx] = d2;
      bestV[worstIdx] = v;
    }
  }

  // Generate IDW Grid
  for (let j = 0; j < ny; j++) {
    // Mapping Loop J (0..ny) to World Y.
    // To match the mask we drew above (where 0 is Top/MaxY), 
    // we must align this logic.
    // If j=0 is top row, y should be maxY.
    const y = maxY - (j / (ny - 1)) * (maxY - minY);

    for (let i = 0; i < nx; i++) {
      const x = minX + (i / (nx - 1)) * (maxX - minX);
      const idx = j * nx + i;

      // OPTIMIZATION: If we have a polygon mask, check it first.
      // If alpha is zero, skip IDW math completely.
      let polyAlpha = 1.0;
      if (maskPixels) {
        // maskPixels is 0..255. 
        polyAlpha = maskPixels[idx * 4 + 3] / 255.0;
        if (polyAlpha < 0.02) { // Threshold to skip invisible pixels
          vField[idx] = maxTime + 1;
          aField[idx] = 0;
          continue;
        }
      }

      // find K nearest
      const bestD2 = new Array(idwK).fill(Infinity);
      const bestV = new Array(idwK).fill(maxTime);
      let d2min = Infinity;

      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        const ddx = p.x - x;
        const ddy = p.y - y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < d2min) d2min = d2;
        updateKNN(bestD2, bestV, d2, p.v);
      }

      const distFade = d2min >= maxDist2 ? 0 : Math.pow(1 - Math.sqrt(d2min) / maxDist, 0.7);
      if (distFade <= 0) {
        vField[idx] = maxTime + 1;
        aField[idx] = 0;
        continue;
      }

      // Interpolate
      let wsum = 0;
      let vsum = 0;
      for (let kk = 0; kk < idwK; kk++) {
        const d2 = bestD2[kk];
        const v = bestV[kk];
        if (!Number.isFinite(d2)) continue;
        const w = 1 / (Math.pow(d2 + eps, idwPower / 2));
        wsum += w;
        vsum += w * v;
      }
      let vHat = wsum > 0 ? vsum / wsum : maxTime + 1;

      // Banding
      if (Number.isFinite(vHat) && vHat >= 0 && bandIntervalMin > 0) {
        vHat = Math.floor(vHat / bandIntervalMin) * bandIntervalMin;
      }

      vField[idx] = vHat;

      // Combine Alphas
      const timeFade = vHat <= maxTime ? 1 : 0;
      
      let finalShapeMask = 1;

      if (maskPixels) {
         // Use the polygon mask we computed earlier
         finalShapeMask = polyAlpha; 
      } else {
         // Fallback to old radial mask if no polygons provided
         const dxO = x - originPt.x;
         const dyO = y - originPt.y;
         const r2 = dxO * dxO + dyO * dyO;
         if (r2 <= innerR2) finalShapeMask = 1;
         else if (r2 >= outerR2) finalShapeMask = 0;
         else {
           const r = Math.sqrt(r2);
           const t = clamp((outerR - r) / (outerR - innerR), 0, 1);
           finalShapeMask = t * t * (3 - 2 * t);
         }
      }

      aField[idx] = distFade * timeFade * finalShapeMask;
    }
  }

  // Blur (Box Blur)
  function boxBlur(src: Float32Array, dst: Float32Array, w: number, h: number) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let c = 0;
        for (let yy = -1; yy <= 1; yy++) {
          const y2 = y + yy;
          if (y2 < 0 || y2 >= h) continue;
          for (let xx = -1; xx <= 1; xx++) {
            const x2 = x + xx;
            if (x2 < 0 || x2 >= w) continue;
            const idx2 = y2 * w + x2;
            s += src[idx2];
            c++;
          }
        }
        dst[y * w + x] = s / Math.max(1, c);
      }
    }
  }

  if (blurPasses > 0) {
    let tmp = new Float32Array(N);
    for (let p = 0; p < blurPasses; p++) {
      boxBlur(vField, tmp, nx, ny);
      vField.set(tmp);
    }
  }

  // Paint to canvas
  const img = ctx.createImageData(nx, ny);
  const data = img.data;

  for (let idx = 0; idx < N; idx++) {
    const v = vField[idx];
    const aMask = aField[idx]; // This now includes the polygon clip alpha

    const o = 4 * idx;

    if (aMask <= 0 || v > maxTime) {
      data[o + 0] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 0;
      continue;
    }

    const [r, g, b, a] = timeToRGBA(v);

    // Dither / Noise
    const xPix = idx % nx;
    const yPix = Math.floor(idx / nx);
    const noise = Math.sin((xPix * 12.9898 + yPix * 78.233) * 0.017) * 43758.5453;
    const frac = noise - Math.floor(noise); 
    const noiseFade = aMask < 0.35 ? (0.85 + 0.30 * frac) : 1.0;

    const aa = Math.round(clamp((a / 255) * aMask * noiseFade, 0, 0.95) * 255);

    data[o + 0] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = aa;
  }

  ctx.putImageData(img, 0, 0);

  const dataUrl = canvas.toDataURL("image/png");

  // Calculate bounds for Leaflet
  const sw = L.Projection.SphericalMercator.unproject(L.point(minX, maxY));
  const ne = L.Projection.SphericalMercator.unproject(L.point(maxX, minY));
  const bounds = L.latLngBounds(L.latLng(sw.lat, sw.lng), L.latLng(ne.lat, ne.lng));

  return { dataUrl, bounds, opacity: overlayOpacity };
}


function HeatmapOverlay({ fc, polygons }: { fc: GeoJSONFeatureCollectionPoint | null, polygons: GeoJSONFeatureCollection | null }) {
  const map = useMap();

  const overlay = useMemo(() => {
    if (!fc) return null;

    // Fallback for very sparse OD points if not enough for IDW
    if ((fc.features?.length ?? 0) < 5) {
       const rings = buildConcentricCircleBands(fc, { binCount: 3, maxNonOriginPoints: 5 });
       if (rings) return rings;
    }

    const built = buildIsoHeatmapOverlay(fc, {
      nx: 260,
      ny: 260,
      sampleMax: 900,
      maxTime: 720,
      fadeStart: 540,
      bandIntervalMin: 30,
      idwK: 10,
      idwPower: 2.2,
      maxDistFactor: 0.85, 
      blurPasses: 2,
      alphaBoost: 0.35, 
      overlayOpacity: 0.78,
      clipPolygons: polygons, // <--- Passed in here for clipping
    });

    if (!built) return null;

    return L.imageOverlay(built.dataUrl, built.bounds, {
      opacity: built.opacity ?? 0.82,
      interactive: false,
      crossOrigin: true,
    });

  }, [fc, polygons]);

  useEffect(() => {
    if (!overlay) return;
    overlay.addTo(map);
    return () => overlay.removeFrom(map);
  }, [overlay]);

  return null;
}

// ===== polygon styling (no hard-coded colors: use opacity + border only; let base map show through) =====
function isoBandStyle(f: any) {
  const level = Number(f?.properties?.level_min ?? 0);
  const maxTime = 240;

  const t = Math.max(0, Math.min(1, level / maxTime));
  // Made polygons much more transparent since Heatmap now fits them perfectly
  const fillOpacity = Math.max(0, Math.min(0.1, 0.1 * Math.pow(1 - t, 1.4))); 
  const strokeOpacity = Math.max(0, Math.min(0.25, 0.25 * (1 - t)));

  return {
    weight: 1,
    opacity: strokeOpacity,
    fillOpacity,
  } as any;
}

export default function MapView(props: {
  cities: CityIndexItem[];
  loading: boolean;
  error: string | null;
  cityA: CityIndexItem | null;
  cityB: CityIndexItem | null;
  onCityClick: (c: CityIndexItem) => void;

  // Layers
  aIsochrones: GeoJSONFeatureCollectionPoint | null;
  aIsoPolygons: GeoJSONFeatureCollection | null;
  aCrossborder: CrossborderRoutesResponse | null;

  aCrossborderShapes: GeoJSONFeature[];
  abShapes: GeoJSONFeature[];
}) {
  const {
    cities,
    loading,
    error,
    cityA,
    cityB,
    onCityClick,
    aIsochrones,
    aIsoPolygons,
    aCrossborder,
    aCrossborderShapes,
    abShapes,
  } = props;

  const cityAId = cityA?.city_id ?? null;
  const cityBId = cityB?.city_id ?? null;

  const aCrossborderFC = useMemo(
    () => ({ type: "FeatureCollection", features: aCrossborderShapes } as any),
    [aCrossborderShapes],
  );
  const abFC = useMemo(() => ({ type: "FeatureCollection", features: abShapes } as any), [abShapes]);

  const overviewMode = !cityA;

  // ===== Layer switch =====
  const showACrossborder = !!cityA && !cityB;
  const showAB = !!cityA && !!cityB; 

  // ======= connected cities (supports BOTH endpoints)
// Preferred: /cities/{city_id}/routes/overview -> connected_cities (domestic + foreign)
// Fallback: /cities/{city_id}/crossborder/routes -> routes[*].foreign_stops (foreign-only)
  const connectionMetaByCityId = useMemo(() => {
    const m = new Map<string, { is_foreign_city: boolean; is_crossborder_connection: boolean }>();

    const ov = (aCrossborder as any)?.connected_cities;
    if (Array.isArray(ov)) {
      for (const cc of ov) {
        const cid = (cc as any)?.city_id;
        if (typeof cid !== "string" || cid.length === 0) continue;
        if (cityAId && cid === cityAId) continue;

        m.set(cid, {
          is_foreign_city: Boolean((cc as any)?.is_foreign_city),
          is_crossborder_connection: Boolean((cc as any)?.is_crossborder_connection),
        });
      }
      return m;
    }

    // fallback: old crossborder payload (foreign-only)
    if (!aCrossborder?.routes) return m;

    for (const payload of Object.values(aCrossborder.routes)) {
      const foreignStops = (payload as any)?.foreign_stops ?? {};
      for (const stop of Object.values(foreignStops)) {
        const cid = (stop as any)?.city_id;
        if (typeof cid === "string" && cid.length > 0) {
          if (cityAId && cid === cityAId) continue;
          m.set(cid, { is_foreign_city: true, is_crossborder_connection: true });
        }
      }
    }

    return m;
  }, [aCrossborder, cityAId]);

  const connectedCityIdSet = useMemo(() => {
    const s = new Set<string>();
    for (const k of connectionMetaByCityId.keys()) s.add(k);
    return s;
  }, [connectionMetaByCityId]);

  // ======= representative stop coord for each connected foreign city (first stop) =======
  const connectedCityStopCoord = useMemo(() => {
    const m = new Map<string, { lat: number; lon: number; stop_id?: string }>();
    if (!aCrossborder?.routes) return m;

    for (const payload of Object.values(aCrossborder.routes)) {
      const foreignStops = (payload as any)?.foreign_stops ?? {};
      for (const stop of Object.values(foreignStops)) {
        const cid = (stop as any)?.city_id;
        const lat = (stop as any)?.stop_lat;
        const lon = (stop as any)?.stop_lon;
        const sid = (stop as any)?.stop_id;

        if (typeof cid === "string" && typeof lat === "number" && typeof lon === "number") {
          if (!m.has(cid)) m.set(cid, { lat, lon, stop_id: sid });
        }
      }
    }
    return m;
  }, [aCrossborder]);

  const connectedCities = useMemo(() => {
    if (!cityAId) return [];
    if (connectedCityIdSet.size === 0) return [];
    return cities.filter((c) => connectedCityIdSet.has(c.city_id));
  }, [cities, connectedCityIdSet, cityAId]);

  return (
    <div className={styles.root}>
      <MapContainer center={EUROPE_CENTER} zoom={EUROPE_ZOOM} className={styles.map} preferCanvas={true}>
        <TileLayer
          attribution="&copy; OpenStreetMap contributors &copy; CARTO"
          url="https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
        />

        <TileLayer
          attribution="&copy; OpenStreetMap contributors &copy; CARTO"
          url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
        />

        <FitToSelection cityA={cityA} cityB={cityB} />

        {/* ===== Heatmap with Polygon Clipping ===== */}
        {cityA && <HeatmapOverlay fc={aIsochrones} polygons={aIsoPolygons} />}

        {/* Isochrone polygons (Borders only now, as heatmap fills them) */}
        {cityA && aIsoPolygons && aIsoPolygons.features?.length > 0 && (
          <GeoJSON data={aIsoPolygons as any} style={isoBandStyle} />
        )}
        {cityA && <LegendControl maxTime={720} band={30} position="bottomright" />}


        {/* A crossborder route shapes: ONLY when B is not selected */}
        {showACrossborder && aCrossborderShapes.length > 0 && (
            <GeoJSON
              data={aCrossborderFC}
              style={(feat: any) => {
                const props = (feat?.properties ?? {}) as any;
                const isCross =
                  Boolean(props?.crossborder) ||
                  (Array.isArray(props?.foreign_city_ids) && props.foreign_city_ids.length > 0);

                return {
                  color: isCross ? LINE.crossborder : LINE.domestic,
                  weight: LINE.weightA,
                  opacity: LINE.opacity,
                  lineCap: "round",
                  lineJoin: "round",
                } as any;
              }}
            />
          )}


        {/* A-B connection route shapes: ONLY when B is selected */}
        {showAB && abShapes.length > 0 && (
          <GeoJSON
            data={abFC}
            style={() => ({
              weight: 4,
              opacity: 0.9,
            })}
          />
        )}

        {/* Connected-city pins (STOP-based coords), ONLY in A-only mode */}
        {showACrossborder &&
          cityA &&
          connectedCities.map((c) => {
            const rep = connectedCityStopCoord.get(c.city_id);
            const lat = rep?.lat ?? c.center.lat;
            const lon = rep?.lon ?? c.center.lon;
            const isForeign = connectionMetaByCityId.get(c.city_id)?.is_foreign_city ?? false;

            return (
              <CircleMarker
                key={`conn-pin-${c.city_id}`}
                center={[lat, lon]}
                radius={7}
                pathOptions={{
                  stroke: true as any,
                  weight: 2,
                  opacity: 0.9,
                  fillOpacity: 0.95,
                  color: isForeign ? "#e63946" : "#5AA9E6",
                  fillColor: isForeign ? "#e63946" : "#5AA9E6",
                }}
                eventHandlers={{ click: () => onCityClick(c) }}
              >
                <Popup>
                  <div style={{ minWidth: 240 }}>
                    <div style={{ fontWeight: 800 }}>
                      {c.city_name} ({c.country_code})
                    </div>
                    <div style={{ marginTop: 6 }}>
                      {c.iscapital === true && <div style={{ fontWeight: 500 }}>Capital</div>}
                      <div>International route count: {c.route_count}</div>
                      <div>International trip count: {c.trip_count}</div>
                      {rep?.stop_id && (
                        <div>
                          rep_stop_id: <code>{rep.stop_id}</code>
                        </div>
                      )}
                      <div style={{ marginTop: 6, fontWeight: 800 }}>[Connected to A]</div>
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}

        {/* City markers (still centroid markers for overview) */}
        {cities.map((c) => {
          const isA = cityAId === c.city_id;
          const isB = cityBId === c.city_id;
          const isConnected = cityA ? connectedCityIdSet.has(c.city_id) : false;

          let radius = cityRadiusOriginal(c);

          let fillColor = overviewMode ? overviewFillColor(c) : "#9aa3af";
          let fillOpacity = overviewMode ? 0.7 : 0.06;
          let opacity = overviewMode ? 0.45 : 0.06;

          if (isA) {
            radius = Math.max(14, radius + 8);
            fillColor = "#ff8a00";
            fillOpacity = 0.98;
            opacity = 0.98;
          } else if (isB) {
            radius = Math.max(14, radius + 8);
            fillColor = "#6b5cff";
            fillOpacity = 0.98;
            opacity = 0.98;
          } else if (cityA && isConnected) {
            fillOpacity = 0.02;
            opacity = 0.02;
          }

          return (
            <CircleMarker
              key={c.city_id}
              center={[c.center.lat, c.center.lon]}
              radius={radius}
              pathOptions={{
                stroke: false as any,
                weight: 0,
                fillColor,
                fillOpacity,
                opacity,
              }}
              eventHandlers={{ click: () => onCityClick(c) }}
            >
              <Popup>
                <div style={{ minWidth: 240 }}>
                  <div style={{ fontWeight: 800 }}>
                    {c.city_name} ({c.country_code})
                  </div>
                  <div style={{ marginTop: 6 }}>
                    {c.iscapital === true && <div style={{ fontWeight: 500 }}>Capital</div>}
                    <div>International route count: {c.route_count}</div>
                    <div>International trip count: {c.trip_count}</div>
                    {isA && <div style={{ marginTop: 6, fontWeight: 800 }}>[Selected as A]</div>}
                    {isB && <div style={{ marginTop: 6, fontWeight: 800 }}>[Selected as B]</div>}
                    {!isA && !isB && cityA && isConnected && (
                      <div style={{ marginTop: 6, fontWeight: 800 }}>[Connected to A]</div>
                    )}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <div className={styles.statusBar}>
        {loading && <span>Loading cities…</span>}
        {error && <span className={styles.error}>Cities error: {error}</span>}
        {!loading && !error && <span>Cities loaded: {cities.length}</span>}
        <span className={styles.hint}>Click: A then B. Third click restarts A.</span>
      </div>
    </div>
  );
}