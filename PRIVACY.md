# Privacy & Data Protection — CivicResolve

CivicResolve is a Digital Public Good. It handles information that can identify
a specific person and the exact spot of a civic problem, so this page documents
what is collected, why, and who can see it.

## What a citizen report contains

| Data | Why it is needed |
| --- | --- |
| Mobile number | Sign-in and OTP verification. Residents without a smartphone account can still use voice reporting. |
| Report location (latitude/longitude) | Routes the work order to the right ward and department. Location is required — reports are not accepted at a default map position. |
| Text description, category | What is wrong and which team is notified. |
| Photo (optional) | Confirms severity and helps the department scope the work. |
| Voice note (optional) | Transcribed and translated for department staff so language is not a barrier. |
| Name (optional) | Only if the citizen chooses to give it. |

## How the data is used

- Reports are visible to the civic department responsible for that category and
  ward, and to administrators who triage and escalate them.
- Anonymous aggregate views (hotspots, category pressure, district indices) are
  shown to policymakers. **Aggregated demand intelligence is not linked back to
  individual citizens** in the policymaker dashboard.
- Photo and audio are analysed with Google Gemini to classify the issue,
  estimate severity and detect hazards. Only the derived classification is
  stored; the raw audio is used for transcription and then discarded.

## What is not done

- No data is sold, and no third-party advertising or tracking is embedded.
- No precise citizen location is published in any public view.
- No account is required to file a report beyond an OTP-verified mobile number.

## Retention

- Report and work-order records are retained for the statutory period required
  by the receiving municipal body, then archived or deleted.
- Voice recordings are used for transcription only and are not retained.
- Aggregated, de-identified demand statistics may be retained indefinitely
  because they cannot be traced back to an individual.

## Consent

Filing a report through CivicResolve constitutes consent to the processing
described above for the purpose of resolving the grievance. Consent can be
withdrawn at any time by contacting the department that received the report,
which will delete or anonymise the record on request.

## Your rights

Under the Digital Personal Data Protection Act, 2023 a Data Principal may
request access to, correction of, and erasure of their personal data, and may
nominate someone to exercise these rights on their behalf. Requests should be
directed to the department that received the report, or to the address below.

## Contact

Data protection queries: `privacy@civicresolve.in`
*(placeholder — replace with the deploying agency's contact before going live)*

## Deployment note for agencies

Any body deploying CivicResolve inherits responsibility for this data. Before
production use, replace the contact above, state the retention period that
applies to your body, and confirm your department's own privacy notice covers
the citizen reports it receives through this platform.
