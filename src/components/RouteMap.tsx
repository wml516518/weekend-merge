import { useState } from "react";
import { Minus, Plus, Navigation } from "lucide-react";
import type { Itinerary } from "@/contracts/agent";
export function RouteMap({
  plan,
  activeId,
  onSelect,
}: {
  plan: Itinerary;
  activeId?: string;
  onSelect?: (id: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const lng = plan.stops.map((p) => p.longitude),
    lat = plan.stops.map((p) => p.latitude);
  const minLng = Math.min(...lng),
    maxLng = Math.max(...lng),
    minLat = Math.min(...lat),
    maxLat = Math.max(...lat);
  const mapStops = plan.stops.map((p, i) => ({
    ...p,
    x:
      maxLng === minLng
        ? 330
        : 180 + ((p.longitude - minLng) / (maxLng - minLng)) * 300,
    y:
      maxLat === minLat
        ? 90 + i * 100
        : 85 + ((maxLat - p.latitude) / (maxLat - minLat)) * 305,
  }));
  const activeIndex = Math.max(
    0,
    plan.stops.findIndex((p) => p.id === activeId),
  );
  return (
    <div className="map-shell">
      <div className="map-top">
        <span>
          <span className="live-dot" />
          路线示意
        </span>
        <span>上海 · {plan.stops[0]?.area}</span>
      </div>
      <svg
        className="city-map"
        viewBox="0 0 680 490"
        role="img"
        aria-label="路线示意图，可点击站点序号"
      >
        <defs>
          <pattern
            id="blocks"
            width="130"
            height="100"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(-20)"
          >
            <rect width="130" height="100" fill="#eeeee6" />
            <rect x="8" y="8" width="48" height="36" rx="5" fill="#e2e3d9" />
            <rect x="65" y="8" width="57" height="36" rx="5" fill="#e4e5dd" />
            <rect x="8" y="54" width="70" height="38" rx="5" fill="#e2e3d9" />
            <rect x="88" y="54" width="34" height="38" rx="5" fill="#e7e6dd" />
            <path
              d="M0 49H130M61 0V49M83 49V100"
              stroke="#fffef8"
              strokeWidth="9"
            />
          </pattern>
        </defs>
        <g
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "50% 50%",
            transition: "transform .25s",
          }}
        >
          <rect width="680" height="490" fill="url(#blocks)" />
          <path
            d="M615 -50C480 60 640 155 570 220S600 360 750 380"
            fill="none"
            stroke="#c5d8d7"
            strokeWidth="65"
          />
          <path
            d="M-20 350 550 20M35 0 390 490M0 180 670 420"
            stroke="#fffef9"
            strokeWidth="18"
          />
          <path
            d="M-20 350 550 20M35 0 390 490M0 180 670 420"
            stroke="#d8d8cb"
            strokeWidth="1"
          />
          <path d="M105 265 180 230 215 305 132 344Z" fill="#cbd9bc" />
          <path d="m385 55 60-18 37 55-60 38Z" fill="#cbd9bc" />
          <g fill="#9a9e93" fontSize="13" fontFamily="sans-serif">
            <text x="100" y="70">
              上海街区
            </text>
            <text x="400" y="167">
              城市道路
            </text>
            <text x="115" y="304">
              街心公园
            </text>
            <text x="340" y="390" transform="rotate(21 340 390)">
              周末路线
            </text>
            <text x="45" y="410">
              街区示意
            </text>
            <text x="585" y="140" fill="#7f9f9f" transform="rotate(70 585 140)">
              滨水区域
            </text>
          </g>
          <polyline
            points={mapStops.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#fff"
            strokeWidth="9"
            strokeLinejoin="round"
          />
          <polyline
            points={mapStops.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#536d52"
            strokeWidth="4"
            strokeDasharray="7 6"
            strokeLinejoin="round"
          />
          {mapStops.map((p, i) => (
            <g
              key={p.id}
              className="map-pin"
              onClick={() => {
                onSelect?.(p.id);
              }}
              role="button"
              tabIndex={0}
              aria-label={`查看第 ${i + 1} 站 ${p.name}`}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelect?.(p.id);
              }}
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={i === activeIndex ? 23 : 19}
                fill={i === activeIndex ? "#354e44" : "#fff"}
                stroke={i === activeIndex ? "#fff" : "#687e5d"}
                strokeWidth="3"
              />
              <text
                x={p.x}
                y={p.y + 5}
                textAnchor="middle"
                fill={i === activeIndex ? "white" : "#354e44"}
                fontSize="15"
                fontWeight="700"
              >
                {i + 1}
              </text>
              <rect
                x={p.x + 26}
                y={p.y - 16}
                width="104"
                height="30"
                rx="5"
                fill="#fffef9"
                opacity=".96"
              />
              <text x={p.x + 35} y={p.y + 4} fontSize="11" fill="#465547">
                <title>{p.name}</title>
                {p.name.length > 9 ? `${p.name.slice(0, 8)}…` : p.name}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <div className="map-bottom">
        <span>原创示意地图 · 路线为估算，非实时导航</span>
        <div>
          <button
            aria-label="缩小地图"
            onClick={() => setZoom((z) => Math.max(0.8, z - 0.15))}
          >
            <Minus size={16} />
          </button>
          <button
            aria-label="放大地图"
            onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))}
          >
            <Plus size={16} />
          </button>
          <button aria-label="重置地图视图" onClick={() => setZoom(1)}>
            <Navigation size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
