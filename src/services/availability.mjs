export function createAvailabilityService(rpc) {
  return {
    list: (hospitalId, identity, signal) => rpc('bedlink_read_availability',
      { p_hospital_id: hospitalId }, identity, signal),
    save: (hospitalId, poolId, input, identity, signal) => rpc('bedlink_update_availability',
      { p_hospital_id: hospitalId, p_bed_pool_id: poolId, ...input }, identity, signal),
  };
}
