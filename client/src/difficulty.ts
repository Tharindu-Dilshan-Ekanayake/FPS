export type Difficulty = "easy" | "medium" | "hard";

export const DIFFICULTY_PRESETS: Record<
  Difficulty,
  {
    label: string;
    description: string;
    moveSpeed: number;
    fireInterval: number;
    fireJitter: number;
    accuracy: number;
    damage: number;
    reactionDelay: number;
  }
> = {
  easy: {
    label: "Easy",
    description: "Slow to react, wide aim — a forgiving warm-up bot.",
    moveSpeed: 1.0,
    fireInterval: 1.7,
    fireJitter: 0.6,
    accuracy: 0.4,
    damage: 6,
    reactionDelay: 0.9,
  },
  medium: {
    label: "Medium",
    description: "Balanced aim and pace — a fair 1v1 fight.",
    moveSpeed: 1.5,
    fireInterval: 1.15,
    fireJitter: 0.4,
    accuracy: 0.62,
    damage: 8,
    reactionDelay: 0.5,
  },
  hard: {
    label: "Hard",
    description: "Fast reflexes, tight aim — a real duel.",
    moveSpeed: 2.0,
    fireInterval: 0.75,
    fireJitter: 0.25,
    accuracy: 0.82,
    damage: 10,
    reactionDelay: 0.25,
  },
};
