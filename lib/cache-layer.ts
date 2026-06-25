import { unstable_cache } from "next/cache";
import { supabase } from "./supabase";

// Next.js App Router provides 'unstable_cache' to cache database queries
// that aren't using standard 'fetch()'. Since the Supabase JS client doesn't
// always utilize the fetch cache (especially for complex queries), we can wrap
// it manually to provide a persistent caching layer in your Server Components.

export const getCachedOrganizationData = unstable_cache(
  async (organizationId: string) => {
    // Example: Fetch organization products and structure, which doesn't change often
    const { data: products } = await supabase
      .schema("kunity")
      .from("savings_products")
      .select("*")
      .eq("organization_id", organizationId);
      
    return products || [];
  },
  ['organization-base-data'], // Cache Key
  {
    revalidate: 3600, // Cache for 1 hour
    tags: ['organization-data'] // Tag to selectively purge later
  }
);
