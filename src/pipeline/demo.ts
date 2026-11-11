// A scripted call, so the screen can be seen working with no keys and no
// microphone. The cards are hand-written sample content, labelled as such.
import type { Extraction } from '../llm/extraction.js';

export type DemoStep =
  | { say: string; speaker: string; cards?: Extraction }
  | { wait: number };

const term = (
  canonical: string,
  heard_as: string,
  kind: Extraction['terms'][number]['kind'],
  one_liner: string,
  bullets: string[],
  why_here: string | null,
): Extraction['terms'][number] => ({ canonical, heard_as, kind, one_liner, bullets, why_here, related: [], confidence: 0.95, knowledge: 'known', needs_grounding: false });

export const DEMO: DemoStep[] = [
  { wait: 900 },
  {
    speaker: '2',
    say: 'על ה-dev board של SiMa, המודליקס החדש, צריך להריץ RF-DETR Nano',
    cards: {
      terms: [
        term('SiMa.ai Modalix', 'המודליקס', 'board', 'SiMa.ai’s second-generation edge-AI chip, built for multimodal models.', [
          'A system-on-chip: ML accelerator and Arm CPUs together',
          'Models are compiled for it with SiMa’s Palette SDK',
          'Comes as modules and dev kits in several performance tiers',
        ], 'This is the board the customer wants the model to run on.'),
        term('RF-DETR Nano', 'RF-DETR Nano', 'model', 'Smallest version of RF-DETR, Roboflow’s real-time transformer object detector.', [
          'Transformer-based, so it needs no NMS clean-up step',
          'Nano trades some accuracy for speed on small devices',
          'Usually exported to ONNX before compiling for a chip',
        ], 'This is the model they need running on that board.'),
      ],
      relations: [
        {
          terms: ['RF-DETR Nano', 'SiMa.ai Modalix'],
          how: 'The model is exported to ONNX, quantized, then compiled with the Palette SDK to run on the Modalix accelerator.',
          gotcha: 'Layers the compiler does not support fall back to the CPU and cost speed.',
        },
      ],
    },
  },
  { wait: 2600 },
  {
    speaker: '2',
    say: 'ואחרי קוונטיזציה ל-INT8 ה-mAP ירד לנו בשתי נקודות',
    cards: {
      terms: [
        term('INT8 quantization', 'קוונטיזציה ל-INT8', 'concept', 'Storing a model’s numbers as 8-bit integers instead of 32-bit floats.', [
          'Makes the model smaller and much faster on edge chips',
          'Usually costs a little accuracy',
          'Needs a calibration set of representative images',
        ], 'They quantized the model and are describing what it cost them.'),
        term('mAP', 'mAP', 'metric', 'Mean average precision: the standard accuracy score for object detectors.', [
          'Higher is better; usually measured on the COCO dataset',
          'Rewards finding objects and boxing them precisely',
          'A drop after quantization is the number to watch',
        ], 'Two points lost is the accuracy price of going to INT8.'),
      ],
      relations: [],
    },
  },
  { wait: 2400 },
  // Small talk: nothing here deserves a card, and none appears.
  { speaker: '1', say: 'מעולה, תשלחו לי את המודל ואני אבדוק את זה אצלנו' },
  { wait: 1500 },
];
