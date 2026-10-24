'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { X } from 'lucide-react';

const ALL_VALUE = '__all__';

interface FilterField {
  key: string;
  name: string;
  values: string[];
  builtIn: boolean;
}

interface SpoolFilterBarProps {
  filters: Record<string, string | null>;
  onFilterChange: (key: string, value: string | null) => void;
  onClearAll: () => void;
  fields: FilterField[];
  extra?: React.ReactNode;
}

export function SpoolFilterBar({
  filters,
  onFilterChange,
  onClearAll,
  fields,
  extra,
}: SpoolFilterBarProps) {
  // Check if any filters are active
  const hasActiveFilters = Object.values(filters).some((v) => v !== null);

  // Collect active filter badges
  const activeBadges: { key: string; label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      const field = fields.find((f) => f.key === key);
      activeBadges.push({
        key,
        label: field?.name || key,
        value,
      });
    }
  }

  // Only show fields that have values
  const fieldsWithValues = fields.filter(f => f.values.length > 0);

  return (
    <div className="border-b p-2 space-y-2">
      {/* Filter dropdowns row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {fieldsWithValues.map((field) => (
            <Select
              key={field.key}
              value={filters[field.key] || ALL_VALUE}
              onValueChange={(value) => onFilterChange(field.key, value === ALL_VALUE ? null : value)}
            >
              <SelectTrigger className="h-8 w-auto min-w-[100px] text-xs">
                <SelectValue placeholder={field.name} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>Összes ({field.name})</SelectItem>
                {field.values.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}

          {/* Clear all button */}
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearAll}
              className="h-8 text-xs text-muted-foreground hover:text-foreground"
            >
              Szűrők törlése
            </Button>
          )}
        </div>

        {extra && <div className="flex-shrink-0">{extra}</div>}
      </div>

      {/* Active filter badges */}
      {activeBadges.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground mr-1">Active:</span>
          {activeBadges.map((badge) => (
            <Badge
              key={badge.key}
              variant="secondary"
              className="text-xs py-0 px-2 h-5 gap-1"
            >
              {badge.value}
              <button
                onClick={() => onFilterChange(badge.key, null)}
                className="ml-0.5 hover:bg-muted rounded-full"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
