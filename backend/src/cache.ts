/**
 * Cache de conversii (§25): cheie = sha256(sursă normalizată + versiune reguli + model).
 * În memorie + persistat într-un fișier JSON (backend/.cache/conversions.json),
 * ca să supraviețuiască repornirii. Se înlocuiește cu SQLite în Etapa 2 fără
 * a schimba interfața.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GROQ_MODEL, RULES_VERSION } from "./rules";
import { normalizeSource, type ValidationResult } from "./validator";

export type CacheEntry = {
  latex: string;
  validation: ValidationResult;
  approvedAt: string;
  /** "auto" = trecut de validator cu OK; "manual" = acceptat/editat în review. */
  origin: "auto" | "manual";
};

export function cacheKey(source: string, suppressMultiplication = false): string {
  const material = [
    normalizeSource(source),
    suppressMultiplication ? "overline" : "",
    RULES_VERSION,
    GROQ_MODEL,
  ].join("\u0000");
  return createHash("sha256").update(material).digest("hex");
}

export class ConversionCache {
  private map = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, CacheEntry>;
        for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
      } catch (err) {
        console.warn("Cache: fișier corupt, pornesc gol.", err);
      }
    }
  }

  get(key: string): CacheEntry | undefined {
    const hit = this.map.get(key);
    if (hit) this.hits++;
    else this.misses++;
    return hit;
  }

  set(key: string, entry: CacheEntry): void {
    this.map.set(key, entry);
    this.persist();
  }

  delete(key: string): void {
    this.map.delete(key);
    this.persist();
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)), "utf8");
    } catch (err) {
      console.warn("Cache: nu am putut persista.", err);
    }
  }
}

export const defaultCacheFile = path.resolve(__dirname, "..", ".cache", "conversions.json");
