// A one-slot bridge so the settings tab can ask for the AI consent without main.ts growing: src/digest/register.ts sets the gate, the tab calls it.
export type ConsentGate = () => Promise<boolean>;
let gate: ConsentGate | null = null;
export const setConsentGate = (g: ConsentGate | null): void => {
  gate = g;
};
/** Ask the person to agree. Fails closed: with no gate (the digest is not wired) the answer is no. */
export const askConsentGate = (): Promise<boolean> => (gate ? gate() : Promise.resolve(false));
