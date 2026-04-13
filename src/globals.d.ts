import { apiFetch as apiFetchType } from "./shared/api";

declare global {
  const apiFetch: typeof apiFetchType;
}
