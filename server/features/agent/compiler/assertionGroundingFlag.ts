/** Assertion grounding — permanently on, no env flag. Corrects an expectText value that reformats
 * the target's real label to the actual observed text (literal toContainText else fails a correct app). */
export function isAssertionGroundingEnabled(): boolean {
  return true;
}
