export const PORTS = {
  as: 4010,
  rsA: 4020,
  rsB: 4021,
  control: 4099,
} as const;

export const ORIGINS = {
  as: `https://localhost:${PORTS.as}`,
  rsA: `https://localhost:${PORTS.rsA}`,
  rsB: `https://localhost:${PORTS.rsB}`,
  control: `http://localhost:${PORTS.control}`,
} as const;
