# Step 5 client sequence

Run against your configured local API with legitimate dispatcher/nurse access tokens. IDs below come from responses; no fabricated example UUID needs to exist. This illustrates calls, not a UI or an automatic fallback loop. Full request/response JSON remains in the [contract fixtures](examples/README.md).

```js
import { createBedLinkApi, createIdempotencyKey } from './client/bedlink-api.mjs';

const dispatch = createBedLinkApi({ baseUrl, getAccessToken: getDispatcherAccessToken });
const createKey = createIdempotencyKey(); // retain with the intent until its outcome is known
const created = await dispatch.createPatientRequest({
  patientReference: 'ANON_42',
  needs: { location: { latitude: 19.076, longitude: 72.878 },
    resources: ['icu', 'oxygen'], specialty: null },
}, { idempotencyKey: createKey });

const requestId = created.data.request.id;
// UI displays nextBest and gets an explicit selection; no automatic createAttempt.
const selected = await getDispatcherSelection(created.data.nextBest);
const sendKey = createIdempotencyKey();
const sent = await dispatch.createAttempt(requestId, {
  hospitalId: selected.hospital.id, bedPoolId: selected.bedPool.id,
}, { idempotencyKey: sendKey });
const attemptId = sent.data.request.activeAttemptId;

// Separately, authenticated staff at that hospital read their assigned inbox.
const nurse = createBedLinkApi({ baseUrl, getAccessToken: getAssignedNurseAccessToken });
const inbox = await nurse.getHospitalInbox(selected.hospital.id);
// Display inbox pendingAttempts and its absolute responseDeadlineAt.
const acceptKey = createIdempotencyKey();
const accepted = await nurse.acceptAttempt(selected.hospital.id, attemptId,
  { idempotencyKey: acceptKey });

// Only record an actual arrival, before the returned hold.expiresAt.
const arrivalKey = createIdempotencyKey();
const arrived = await dispatch.recordArrival(requestId, accepted.data.hold.id,
  { idempotencyKey: arrivalKey });
```

On a rejected or timed-out attempt, fetch `getPatientRequest(requestId)`, inspect `nextBest.outcome`, and let dispatch choose before creating another attempt. Empty results are valid 200 responses. The original successful mutation key replays the original response even if a hold has since expired; status polling gives current state. Keep rejection/cancellation reason codes to the enums in OpenAPI. Do not add patient names, notes, phone numbers or clinical fields.
