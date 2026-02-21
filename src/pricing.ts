/**
 * Pricing Service - Feature flags and plan management
 * Task: cw-live-20260221-3
 */

import { toml } from 'bun';

export interface PricingTier {
  name: string;
  description: string;
  monthlyPriceUsd: number;
  maxConcurrentSessions: number;
  maxHoursPerMonth: number;
  features: string[];
}

export interface PricingConfig {
  pricingExperiment: {
    enabled: boolean;
    experimentId: string;
    variant: 'control' | 'test_20pct_increase';
  };
  pricingPlans: {
    tier: PricingTier[];
    testVariant?: {
      proMonthlyPriceUsd: number;
      enterpriseMonthlyPriceUsd: number;
    };
  };
  conversionEvents: {
    trackEvents: string[];
  };
  eventAnalytics: {
    provider: string;
    tableName: string;
    retentionDays: number;
  };
}

let configCache: PricingConfig | null = null;
let configLoadTime = 0;
const CONFIG_CACHE_TTL_MS = 60_000; // 1 minute cache

/**
 * Load pricing configuration from config/pricing.toml
 */
export async function loadPricingConfig(): Promise<PricingConfig> {
  const now = Date.now();
  if (configCache && (now - configLoadTime) < CONFIG_CACHE_TTL_MS) {
    return configCache;
  }

  const configPath = new URL('../config/pricing.toml', import.meta.url).pathname;
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    throw new Error(`Pricing config not found at ${configPath}`);
  }

  const text = await file.text();
  const parsed = toml.parse(text) as unknown as PricingConfig;

  // Apply test variant prices if experiment is active
  if (parsed.pricingExperiment.enabled && parsed.pricingExperiment.variant === 'test_20pct_increase' && parsed.pricingPlans.testVariant) {
    const pro = parsed.pricingPlans.tier.find(t => t.name === 'pro');
    const enterprise = parsed.pricingPlans.tier.find(t => t.name === 'enterprise');

    if (pro && parsed.pricingPlans.testVariant.proMonthlyPriceUsd) {
      pro.monthlyPriceUsd = parsed.pricingPlans.testVariant.proMonthlyPriceUsd;
    }
    if (enterprise && parsed.pricingPlans.testVariant.enterpriseMonthlyPriceUsd) {
      enterprise.monthlyPriceUsd = parsed.pricingPlans.testVariant.enterpriseMonthlyPriceUsd;
    }
  }

  configCache = parsed;
  configLoadTime = now;
  return parsed;
}

/**
 * Get pricing plans for the current variant
 */
export async function getPricingPlans(): Promise<PricingTier[]> {
  const config = await loadPricingConfig();
  return config.pricingPlans.tier;
}

/**
 * Get pricing plan by name
 */
export async function getPricingPlan(name: string): Promise<PricingTier | undefined> {
  const plans = await getPricingPlans();
  return plans.find(p => p.name.toLowerCase() === name.toLowerCase());
}

/**
 * Track conversion event
 */
export async function trackConversionEvent(
  eventType: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const config = await loadPricingConfig();

  if (!config.pricingExperiment.enabled) {
    return;
  }

  if (!config.conversionEvents.trackEvents.includes(eventType)) {
    return;
  }

  // Implementation for Supabase event tracking would go here
  // For now, log the event
  console.log('[Pricing] Conversion event:', {
    eventType,
    experimentId: config.pricingExperiment.experimentId,
    variant: config.pricingExperiment.variant,
    timestamp: new Date().toISOString(),
    ...metadata,
  });
}

/**
 * Get current experiment info for client-side tracking
 */
export async function getExperimentInfo(): Promise<{
  experimentId: string;
  variant: string;
  enabled: boolean;
} | null> {
  const config = await loadPricingConfig();
  if (!config.pricingExperiment.enabled) {
    return null;
  }

  return {
    experimentId: config.pricingExperiment.experimentId,
    variant: config.pricingExperiment.variant,
    enabled: config.pricingExperiment.enabled,
  };
}
