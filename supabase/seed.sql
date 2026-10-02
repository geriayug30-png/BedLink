-- Fictional demo catalog only. Never creates Auth users, passwords or memberships.
-- Each fixed UUID identifies a demo record. Re-seeding only inserts missing records:
-- existing counts, verification/version values and every other existing field remain untouched.
begin;

insert into public.hospitals (id, name, latitude, longitude, supported_services) values
  ('10000000-0000-4000-8000-000000000001', 'Cedar Demo Hospital', 12.975, 77.605,
    array['emergency','critical_care','cardiac','oxygen_support']::public.hospital_service[]),
  ('10000000-0000-4000-8000-000000000002', 'Lotus Demo Medical Centre', 12.990, 77.620,
    array['emergency','critical_care','cardiac','burns','oxygen_support']::public.hospital_service[]),
  ('10000000-0000-4000-8000-000000000003', 'Ember Demo Burns Centre', 12.960, 77.600,
    array['emergency','critical_care','burns','oxygen_support']::public.hospital_service[]),
  ('10000000-0000-4000-8000-000000000004', 'Willow Demo Community Hospital', 12.940, 77.630,
    array['emergency','oxygen_support']::public.hospital_service[]),
  ('10000000-0000-4000-8000-000000000005', 'Maple Demo Critical Care Centre', 13.000, 77.580,
    array['emergency','critical_care','cardiac','oxygen_support']::public.hospital_service[])
on conflict (id) do nothing;

insert into public.bed_pools
  (id, hospital_id, label, resources, specialties, capacity, reported_free_beds, verified_at)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
    'Cedar ICU + ventilator + oxygen', array['icu','ventilator','oxygen']::public.bed_resource[],
    array['cardiac']::public.bed_specialty[], 10, 2, now() - interval '1 minute'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
    'Lotus ICU + ventilator + oxygen', array['icu','ventilator','oxygen']::public.bed_resource[],
    array['cardiac','burns']::public.bed_specialty[], 12, 3, now() - interval '3 minutes'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
    'Ember burns ICU + oxygen', array['icu','oxygen']::public.bed_resource[],
    array['burns']::public.bed_specialty[], 8, 2, now() - interval '2 minutes'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
    'Willow oxygen - zero availability demo', array['oxygen']::public.bed_resource[],
    '{}'::public.bed_specialty[], 20, 0, now() - interval '1 minute'),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
    'Maple critical care - one bed left demo', array['icu','ventilator','oxygen']::public.bed_resource[],
    array['cardiac']::public.bed_specialty[], 6, 1, now() - interval '2 minutes'),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000005',
    'Maple oxygen - stale verification demo', array['oxygen']::public.bed_resource[],
    '{}'::public.bed_specialty[], 12, 4, now() - interval '35 minutes')
on conflict (id) do nothing;

commit;
