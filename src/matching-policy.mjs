export const DEFAULT_MATCHING_POLICY = Object.freeze({ policyVersion: 'demo-1', responseDeadlineSeconds: 120,
  holdDurationSeconds: 900, agingAfterMinutes: 10, staleAfterMinutes: 30,
  travelWeight: 0.5, freshnessWeight: 0.3, headroomWeight: 0.2,
  travelScoreHorizonMinutes: 60, simulatedSpeedKph: 30, simulatedRoadFactor: 1.3 });

export function readMatchingPolicy(env = {}) {
  const policy = { ...DEFAULT_MATCHING_POLICY };
  const settings = { MATCH_TRAVEL_WEIGHT: 'travelWeight', MATCH_FRESHNESS_WEIGHT: 'freshnessWeight',
    MATCH_HEADROOM_WEIGHT: 'headroomWeight', MATCH_TRAVEL_HORIZON_MINUTES: 'travelScoreHorizonMinutes',
    MATCH_SIMULATED_SPEED_KPH: 'simulatedSpeedKph', MATCH_SIMULATED_ROAD_FACTOR: 'simulatedRoadFactor' };
  for (const [key, field] of Object.entries(settings)) {
    if (env[key] === undefined) continue;
    const n = Number(env[key]);
    if (String(env[key]).trim() === '' || !Number.isFinite(n) ||
      (field.endsWith('Weight') ? n < 0 || n > 1 : n <= 0) ||
      (field === 'simulatedRoadFactor' && n < 1)) throw new Error(`Invalid ${key}`);
    policy[field] = n;
  }
  if (Math.abs(policy.travelWeight + policy.freshnessWeight + policy.headroomWeight - 1) > 1e-12) {
    throw new Error('Matching weights must sum to 1');
  }
  const custom = Object.values(settings).some(field => policy[field] !== DEFAULT_MATCHING_POLICY[field]);
  const version = env.MATCH_POLICY_VERSION?.trim();
  if (custom && (!version || version === 'demo-1')) {
    throw new Error('Custom ranking settings require a distinct MATCH_POLICY_VERSION');
  }
  policy.policyVersion = version || policy.policyVersion;
  return Object.freeze(policy);
}
