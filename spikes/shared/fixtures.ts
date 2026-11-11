export type Fixture = { id: string; text: string; expected_terms: string[]; forbidden_terms: string[] };

// The PLAN §1 example in clean and garbled spellings, plus utterances that
// must produce no card at all.
export const FIXTURES: Fixture[] = [
  { id: 'canon-clean', text: 'על ה-dev board של SiMa, המודליקס החדש, צריך להריץ RF-DETR Nano', expected_terms: ['SiMa.ai Modalix', 'RF-DETR Nano'], forbidden_terms: [] },
  { id: 'canon-hebrew-letters', text: 'על הדב בורד של סימה, המודליקס החדש, צריך להריץ אר אף דיטר נאנו', expected_terms: ['SiMa.ai Modalix', 'RF-DETR Nano'], forbidden_terms: [] },
  { id: 'canon-garbled', text: 'on the seema dev board, the new modelics, you need to run RFD TR nano', expected_terms: ['SiMa.ai Modalix', 'RF-DETR Nano'], forbidden_terms: [] },
  { id: 'canon-split', text: 'אז על הסימא איי מודאליקס אנחנו רוצים RF detter נאנו ב-INT8', expected_terms: ['SiMa.ai Modalix', 'RF-DETR Nano', 'INT8'], forbidden_terms: [] },
  { id: 'no-terms-smalltalk', text: 'מעולה, אז אני אשלח לכם סיכום אחרי הפגישה ונקבע שיחה לשבוע הבא', expected_terms: [], forbidden_terms: ['API', 'Docker'] },
  { id: 'no-terms-general-sw', text: 'we have a REST API in Docker and the latency on the GPU is fine for now', expected_terms: [], forbidden_terms: ['REST', 'API', 'Docker', 'GPU', 'latency'] },
];

export const CONTEXT_TERMS = ['SiMa.ai', 'Modalix', 'MLSoC', 'Palette SDK', 'RF-DETR', 'RF-DETR Nano', 'dev board', 'INT8', 'ONNX', 'Hailo-8', 'Jetson Orin', 'TensorRT'];
