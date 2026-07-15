/**
 * A single coherent synthetic identity per run. Built once, reused for every related field so the whole
 * run stays consistent: First Name "Jordan" → Full Name "Jordan Patel" → email "jordan.patel@example.test".
 * Deterministic — same seed (mission scope) always yields the same identity.
 */
import { SeededRandom } from './seededRandom';
import * as p from './providers';
import type { GeneratedIdentity } from './types';

export function buildIdentity(seed: string): GeneratedIdentity {
  const r = new SeededRandom(`identity:${seed}`);
  const firstName = p.firstName(r);
  const lastName = p.lastName(r);
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    username: p.username(firstName, lastName, r),
    email: p.email(firstName, lastName, r),
    phone: p.phone(r),
    company: p.company(r),
    streetAddress: p.streetAddress(r),
    city: p.city(r),
    state: p.state(r),
    country: p.country(r),
    postalCode: p.postalCode(r),
    password: p.password(r),
  };
}
