export type TextModelLines = {
  getLineContent(lineNumber: number): string;
  getLineCount(): number;
  getLineLength(lineNumber: number): number;
};

export type TextCursor = { column: number; lineNumber: number };

/**
 * Read the text before Monaco's cursor while a model edit is in progress.
 * During executeCommands, Monaco can briefly expose the old cursor against
 * the new (shorter) model, so both coordinates must be bounded first.
 */
export function boundedLinePrefix(
  model: TextModelLines,
  cursor: TextCursor | null,
): string {
  if (!cursor) return "";
  const lineNumber = Math.max(1, Math.min(cursor.lineNumber, model.getLineCount()));
  const character = Math.max(
    0,
    Math.min(cursor.column - 1, model.getLineLength(lineNumber)),
  );
  return model.getLineContent(lineNumber).slice(0, character);
}
