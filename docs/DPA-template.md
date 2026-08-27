# Data Processing Agreement — template

> **DRAFT. NOT LEGAL ADVICE. DO NOT SEND THIS TO A CUSTOMER AS-IS.**
>
> This is an engineering artifact: a structured statement of what the system
> actually does, laid out in the shape of GDPR Article 28(3) so that a lawyer can
> review it quickly and turn it into an executable agreement. Every bracketed
> field needs filling and the whole thing needs a qualified privacy lawyer,
> particularly on the Article 9 question in §3 of `docs/COMPLIANCE.md`.
>
> Where this document and the code disagree, the code is the truth and this
> document is a bug.

---

**Data Processing Agreement**

between

**[ORGANIZER LEGAL NAME]**, [company number], [registered address]
("**Controller**")

and

**[OUR LEGAL NAME]**, [company number], [registered address]
("**Processor**")

together the "Parties".

This Agreement supplements the [Service Agreement / Terms of Service] dated
[DATE] (the "**Principal Agreement**") and takes precedence over it in the event
of conflict on matters of data protection.

---

## 1. Definitions

Terms used here have the meanings given in Regulation (EU) 2016/679 ("**GDPR**").
"**Biometric Data**" means personal data resulting from specific technical
processing relating to the physical characteristics of a natural person which
allows or confirms their unique identification, within the meaning of Article
4(14) GDPR, and includes the face embeddings described in Annex 1.

## 2. Roles

2.1 The Controller determines the purposes and means of processing the personal
data described in Annex 1. The Processor processes it only on the Controller's
documented instructions.

2.2 The Parties agree that the Controller is the operator of the event, is the
party with the direct relationship to the attendees whose images are processed,
and is responsible for the lawfulness of the collection of those images.

2.3 The Processor does not determine its own purposes for the personal data and
shall not do so. In particular the Processor shall not use the personal data to
train, evaluate or improve any machine-learning model, and shall not use it for
any purpose beyond the provision of the Services.

## 3. Controller's obligations

The Controller warrants and undertakes that:

3.1 It has a lawful basis under Article 6 GDPR and a valid exemption under
Article 9(2) GDPR for the processing it instructs, including for individuals
appearing in the photographs who do not themselves use the face-search feature.

3.2 It has displayed a clear photography and biometric-processing notice at every
entrance to the event, and has included equivalent terms in its ticketing or
booking conditions. The Controller shall provide the Processor with a URL or
copy of that notice, which the Processor records against the event.

3.3 Where the event involves children, the Controller has obtained parental or
guardian consent as required by applicable law, and shall complete the separate
attestation required by the Processor's system before the album is made
searchable.

3.4 It shall promptly forward to the Processor any data subject request that
requires action within the Processor's systems.

3.5 It shall not instruct the Processor to process personal data of individuals
located in a jurisdiction not listed as permitted in Annex 3.

## 4. Processor's obligations

The Processor shall:

4.1 **Process only on instruction.** Process the personal data only on the
documented instructions of the Controller, including as to transfers, unless
required otherwise by Union or Member State law, in which case the Processor
shall inform the Controller before processing unless that law prohibits it.

4.2 **Purpose limitation.** Process face embeddings solely to match faces within
the single event to which they belong. The Processor shall not link an embedding
to a name, shall not construct any identity record spanning more than one event,
and shall not retain or reuse any embedding beyond the retention period in Annex 2.

4.3 **Confidentiality.** Ensure that persons authorised to process the personal
data are bound by confidentiality obligations.

4.4 **Security.** Implement the technical and organisational measures in Annex 4.

4.5 **Sub-processors.** Engage sub-processors only as listed in Annex 5. The
Processor shall give the Controller at least [30] days' notice of any intended
addition or replacement, during which the Controller may object on reasonable
data-protection grounds.

4.6 **Data subject rights.** Taking into account the nature of the processing,
assist the Controller by appropriate technical and organisational measures in
responding to requests under Chapter III GDPR. The Processor provides a public
per-event opt-out mechanism by which any individual may require the erasure of
their face vectors from an album and their exclusion from all subsequent searches
of it, without holding an account.

4.7 **Breach notification.** Notify the Controller without undue delay and in any
event within [24] hours of becoming aware of a personal data breach, with the
information required by Article 33(3) to the extent available. The Parties
acknowledge that the return of photographs to an individual other than the
individual depicted constitutes an unauthorised disclosure and is treated as a
personal data breach under this clause.

4.8 **Assistance.** Assist the Controller in complying with Articles 32 to 36
GDPR, including any data protection impact assessment the Controller carries out
in respect of the Services.

4.9 **Deletion.** Delete all personal data at the end of the retention period in
Annex 2, and in any event on termination of the Principal Agreement, save for
records of deletion that contain no personal data of attendees. The Processor
shall on request certify such deletion.

4.10 **Audit.** Make available to the Controller the information necessary to
demonstrate compliance with Article 28 and allow for and contribute to audits,
including inspections, conducted by the Controller or another auditor mandated
by the Controller, on reasonable notice and no more than [once] per year absent
a breach.

## 5. International transfers

The Processor shall not transfer personal data outside the [European Economic
Area / State of Israel] except to a country benefiting from an adequacy decision
or under Standard Contractual Clauses, and in either case subject to a transfer
impact assessment. Current hosting locations are stated in Annex 5.

## 6. Liability and term

6.1 Liability under this Agreement is subject to the limitations in the
Principal Agreement, except where such limitation is prohibited by applicable
data protection law.

6.2 This Agreement takes effect on [DATE] and continues for as long as the
Processor processes personal data on behalf of the Controller.

6.3 Governing law: [JURISDICTION]. *(Align with the Principal Agreement.)*

---

# Annex 1 — Subject matter and nature of processing

**Subject matter.** Provision of a face-search service over an event photograph
album, enabling an attendee to retrieve photographs in which they appear.

**Duration.** From upload of the album until the retention deadline in Annex 2.

**Nature and purpose.** Storage of photographs; automated detection of faces;
computation of numerical face embeddings; similarity search against those
embeddings; delivery of matching photographs to the individual who searched.

**Categories of data subject**

| Category | How they enter the processing |
|---|---|
| Attendees appearing in photographs | Photographed by the Controller at the event |
| Attendees performing a search | Voluntarily capture a selfie |
| Individuals requesting exclusion | Voluntarily use the opt-out |
| The Controller's own personnel | Operator accounts |

**Categories of personal data**

| Data | Special category? |
|---|---|
| Photographs of identifiable individuals | May reveal special-category data by inference |
| **Face embeddings (512-dimensional vectors)** | **Yes — Article 9 biometric data** |
| **Cluster centroids derived from embeddings** | **Yes — a centroid is still a face template** |
| Face geometry: bounding box, detection confidence, size in pixels, head pose, blur | No |
| EXIF capture timestamp | No |
| Salted, non-reversible hash of the searching device's IP address | Pseudonymous |
| Operator name and email | No |

**Data explicitly NOT processed or retained**

- Cropped face images. Only the embedding is derived and stored.
- Facial landmark coordinates.
- The attendee's selfie, or the embedding computed from it. Both exist only in
  memory for the duration of a single search request and are destroyed within 60
  seconds, with the destruction recorded in an audit log.
- Raw IP addresses.
- Names, contact details, or any identifier attached to a face.

# Annex 2 — Retention

| Data | Retention |
|---|---|
| Photographs, previews, thumbnails | Until the event deletion date; default [60] days after the event |
| Face embeddings, geometry, cluster centroids | Same |
| Opt-out embeddings | Same. Retained solely to enforce the individual's own opt-out. |
| Search logs (pseudonymous) | Same |
| Attendee selfie and its embedding | Duration of one request; target under 60 seconds |
| Records of deletion (event identifier, counts, timestamps; no attendee personal data) | [24] months, for accountability under Article 5(2) |

The deletion date is stored against the event and enforced by an automated job,
not by manual process. The system will not accept a deletion date more than 180
days after album creation.

# Annex 3 — Permitted jurisdictions

Events may be processed only for the jurisdictions the Processor has enabled.
The Processor's system refuses others at the database layer.

**Permitted:** Israel; EU/EEA member states as listed in the Processor's system
at the time of contracting.

**Not permitted:** the United States (all states, and expressly Illinois, Texas
and Washington); the United Kingdom; any jurisdiction not affirmatively listed.

# Annex 4 — Technical and organisational measures

| Measure | Implementation |
|---|---|
| Access control | Row Level Security in the database. An operator can reach only their own events. Opt-out embeddings are unreadable by any operator. |
| Attendee isolation | Attendee devices never connect to the database. Search runs server-side under a privileged role with per-event rate limiting. |
| Encryption | TLS in transit. Encryption at rest as provided by the hosting platform. |
| Data minimisation | Faces below the quality threshold are discarded before any embedding is computed. Crops and landmarks are never stored. The database rejects a row for a face that failed the quality gate. |
| Purpose limitation | Enforced structurally: embeddings carry an event identifier and there is no schema path that joins them across events. |
| Automated deletion | Scheduled hourly job; object-store deletion is queued and executed, not assumed to follow from database deletion. |
| Proof of deletion | Audit records with no foreign key to the deleted record, so they survive it. |
| Anti-impersonation | Live camera capture only for search; multi-frame consistency check; rate limiting; all searches logged. |
| Anti-scraping | Watermarked previews; signed URLs with short expiry; non-sequential event identifiers. |
| Accuracy | Match thresholds are set from a labeled evaluation set at a measured precision of at least 99%, are recorded together with the evidence that justified them, and cannot be set by hand. |
| Logging | Searches are logged without biometric data and without raw IP addresses. |

# Annex 5 — Sub-processors and hosting

| Sub-processor | Purpose | Location |
|---|---|---|
| [Supabase] | Database and object storage | [EU region] |
| [Fly.io / Railway] | ML worker container | [EU region] |
| [Cloudflare R2] | Object storage at scale | [EU jurisdiction restriction] |
| [Vercel] | Web application hosting | [EU region] |
| [Twilio] | WhatsApp delivery. Receives a telephone number and a link only; no photograph and no embedding. | [—] |

No third-party face-recognition service is used. Detection and embedding run on
infrastructure controlled by the Processor.

---

**Signed for the Controller**

Name: ______________________  Title: ______________________

Signature: __________________  Date: ______________________

**Signed for the Processor**

Name: ______________________  Title: ______________________

Signature: __________________  Date: ______________________
