import { fakeMethod } from "./fake-method.ts";
import type { MethodCase } from "./method-contract.ts";

/** Every configured method the shared suites run against. Add each real method here as it lands. */
export const methodCases: readonly MethodCase[] = [{ name: "fake", method: fakeMethod() }];
