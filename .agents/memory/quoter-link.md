---
name: Body Quoter link
description: Endpoints and constraints of the companion Intake & Body Quoter app (QUOTER_URL + FLEET_KEY)
---
Part A endpoints (x-fleet-key header): GET /api/quote-by-vin?vin=, /api/intake-by-vin?vin= (found:false = intake predates system), /api/intake-stats?from&to → {days:[{day,intakes}],total,openIntakes}. GET /api/intakes-completed → {intakes:[...]} enumerates completed intakes; "awaiting Final QC" = completed intake with no inspection (server-filtered). Never write to the Quoter's data.
