"use client";

import { useId } from "react";
import { Input } from "@/components/ui/Input";
import { BOLIVIA_CITIES, MAX_CITY_CHARS } from "@/lib/city";
import { useT } from "@/lib/i18n/client";

/**
 * The event's city: free text with the Bolivian capitals as suggestions
 * (a datalist), because some events happen elsewhere. The server normalises
 * whatever is typed (lib/city.ts).
 */
export function CityInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  const listId = useId();
  return (
    <>
      <Input
        label={t.create.city}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t.create.cityPlaceholder}
        maxLength={MAX_CITY_CHARS}
        list={listId}
        autoComplete="off"
      />
      <datalist id={listId}>
        {BOLIVIA_CITIES.map((city) => (
          <option key={city} value={city} />
        ))}
      </datalist>
    </>
  );
}
