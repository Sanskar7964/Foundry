"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceDot } from "recharts";

/** Renders the live constant-product curve and marks the current reserves. */
export function BondingCurveChart({
  initialVirtualSol,
  initialVirtualTokens,
  virtualTokenReserves,
}: {
  initialVirtualSol: number;
  initialVirtualTokens: number;
  virtualTokenReserves: number;
}) {
  const k = initialVirtualSol * initialVirtualTokens;
  const currentTokensSold = Math.max(0, initialVirtualTokens - virtualTokenReserves);
  // Focus the x-axis just beyond the current state. A full-supply axis makes
  // early trades indistinguishable from the origin and hides live movement.
  const maxTokensSold = Math.min(initialVirtualTokens * 0.995, Math.max(currentTokensSold * 1.25, initialVirtualTokens * 0.02));
  const currentPrice = k / Math.max(virtualTokenReserves, 1) ** 2;
  const points = Array.from({ length: 40 }, (_, index) => {
    const tokensSold = (maxTokensSold * index) / 39;
    const remaining = Math.max(initialVirtualTokens - tokensSold, 1);
    return { tokensSold, price: k / remaining ** 2 };
  });
  points.push({ tokensSold: currentTokensSold, price: currentPrice });
  points.sort((a, b) => a.tokensSold - b.tokensSold);

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <defs><linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#D9A441" stopOpacity={0.35} /><stop offset="100%" stopColor="#D9A441" stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid stroke="#332E37" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="tokensSold" tick={{ fill: "#928C93", fontSize: 11 }} tickFormatter={(value) => `${(Number(value) / 1_000_000).toFixed(0)}M`} axisLine={{ stroke: "#332E37" }} tickLine={false} />
          <YAxis tick={{ fill: "#928C93", fontSize: 11 }} axisLine={false} tickLine={false} width={56} tickFormatter={(value) => Number(value).toExponential(1)} />
          <Tooltip contentStyle={{ background: "#1C191E", border: "1px solid #332E37", borderRadius: 4, fontSize: 12 }} labelFormatter={(value) => `${(Number(value) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M tokens sold`} formatter={(value: number) => [`${value.toExponential(4)} SOL / token`, "price"]} />
          <Area type="monotone" dataKey="price" stroke="#D9A441" strokeWidth={2} fill="url(#curveFill)" />
          <ReferenceDot x={currentTokensSold} y={currentPrice} r={5} fill="#D9A441" stroke="#1C191E" label={{ value: "Now", position: "top", fill: "#D9A441", fontSize: 11 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
