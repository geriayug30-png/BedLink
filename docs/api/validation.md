# Validation record

Validated on 2026-10-02 against the files in this directory. All checks below passed. This is validation of a design contract and static mock data, not testing of a backend implementation.

| Check | Result |
| --- | --- |
| YAML parse | Passed with PyYAML 6.0.3 |
| Complete OpenAPI document | Passed `openapi-spec-validator` 0.9.0 for OpenAPI 3.1.0 |
| Component schemas | All 42 checked as JSON Schema Draft 2020-12 |
| Request/response payloads | All 82 raw JSON payloads passed their exact operation/status schemas with `jsonschema` 4.26.0 and date-time format checking |
| HTTP mapping | All 50 exchanges map to declared methods, paths, parameters, request bodies and response statuses; all 13 operations have successful fixtures |
| Negative schema cases | 21 invalid payload variants were rejected as expected |
| Static semantic/structural assertions | 4,096 assertions passed, including repeated field and fixture checks; this is not 4,096 independent behavioral tests |
| Example links | Every OpenAPI `externalValue` resolves to a real payload file; every payload is mapped by the manifest |

The negative cases cover latitude/longitude bounds and types, duplicate/unknown/empty resources, an unsupported specialty, non-UTC and invalid calendar timestamps, missing/invalid nurse versions, negative/fractional counts, unexpected client timestamps/owner fields, inconsistent request/hold fields, a wrong status spelling, an empty successful-match result, inconsistent unverified data, and simulated travel incorrectly claiming traffic support.

The static semantic checker verifies count conservation and nonnegative inventory, computed load, exact data age and freshness, 120-second attempt deadlines, 900-second demo holds, effective timeout/expiry times, rank ordering, Haversine travel calculations, weighted score arithmetic, simultaneous resource/specialty eligibility, excluded hospital IDs, ID relationships between requests/attempts/holds, one live commitment, history ordering, state-dependent fallback presence, the last-bed conflict, arrival inventory changes, unchanged verification on arrival, and identical successful retry bodies/statuses. The examples show inventory after hold expiry and cancellation as well as after acceptance and arrival.

## Reproduce document and payload validation

Install validation tools in a disposable environment, outside the application dependencies:

```text
python -m pip install openapi-spec-validator==0.9.0 PyYAML==6.0.3 jsonschema==4.26.0
python -m openapi_spec_validator docs/api/openapi.yaml
```

Run the following Python from the repository root to check all mapped request and response payloads. It validates schemas and formats; it does not reproduce every project-specific semantic assertion listed above. The one-off generation and extended checking scripts were scratch tools and are not committed as application code.

```python
import json
from pathlib import Path
import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

api = Path("docs/api")
spec = yaml.safe_load((api / "openapi.yaml").read_text(encoding="utf-8"))
uri = "https://bedlink.example/contract"
resource = Resource.from_contents({
    "$schema": "https://json-schema.org/draft/2020-12/schema", **spec
})
registry = Registry().with_resource(uri, resource)

def resolve(node):
    while "$ref" in node:
        parts = node["$ref"][2:].split("/")
        node = spec
        for part in parts:
            node = node[part.replace("~1", "/").replace("~0", "~")]
    return node

def check(filename, schema):
    schema = {"$ref": uri + schema["$ref"]}
    instance = json.loads((api / "examples" / filename).read_text(encoding="utf-8"))
    Draft202012Validator(
        schema, registry=registry, format_checker=FormatChecker()
    ).validate(instance)

manifest = json.loads((api / "examples/_manifest.json").read_text(encoding="utf-8"))
count = 0
for exchange in manifest["exchanges"]:
    path = exchange["pathTemplate"].removeprefix("/api/v1")
    operation = spec["paths"][path][exchange["method"].lower()]
    if "requestFile" in exchange:
        check(exchange["requestFile"], operation["requestBody"]["content"]["application/json"]["schema"])
        count += 1
    response = resolve(operation["responses"][str(exchange["status"])])
    check(exchange["responseFile"], response["content"]["application/json"]["schema"])
    count += 1
print(f"Validated {count} payloads")
```

## Limits and Step 2 verification

No server, database, UI, or deployment was implemented or executed. These checks do not demonstrate real transaction isolation, authorization enforcement, token verification, timekeeping, worker operation, retry storage, or network behavior. JSON Schema cannot alone enforce arithmetic across fields or consistency across concurrent transactions.

Step 2 needs integration tests for cross-hospital/owner access, duplicate and concurrent keys, two different keys for one request, two acceptances for the last bed, stale verification at acceptance, exact deadline boundaries, arrival versus expiry/cancellation, nurse edits racing with holds, failed transactions, worker delays, and out-of-order polling responses. Use the static fixtures as expected contract examples, not as proof that these behaviors have been implemented.

The document format follows [OpenAPI 3.1.0](https://spec.openapis.org/oas/v3.1.0.html), which supports the JSON Schema dialect declared in `openapi.yaml`.
