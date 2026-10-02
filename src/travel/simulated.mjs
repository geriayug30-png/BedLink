// Provider interface: estimate({ origin, destination, policy, signal }) -> TravelEstimate.
// Replacement providers must preserve the wire contract or introduce a reviewed schema change.
export function haversineKm(origin, destination) {
  const radians = degrees => degrees * Math.PI / 180;
  const lat1 = radians(origin.latitude), lat2 = radians(destination.latitude);
  const dLat = lat2 - lat1, dLon = radians(destination.longitude - origin.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export const simulatedTravelProvider = Object.freeze({
  async estimate({ origin, destination, policy, signal }) {
    signal?.throwIfAborted();
    const distance = haversineKm(origin, destination);
    return { distanceKm: Math.round(distance * 10) / 10,
      estimatedTravelMinutes: Math.max(1, Math.ceil(distance * policy.simulatedRoadFactor / policy.simulatedSpeedKph * 60)),
      source: 'simulatedDistance', trafficConsidered: false };
  },
});
