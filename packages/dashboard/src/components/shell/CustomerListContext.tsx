"use client";

import { apiFetch } from "@/lib/api";
import type { CustomerListItem } from "@/types/api";
import * as React from "react";

interface CustomerListContextValue {
  customers: CustomerListItem[];
  loading: boolean;
  refresh: () => void;
}

export const CustomerListContext = React.createContext<CustomerListContextValue>({
  customers: [],
  loading: true,
  refresh: () => {},
});

export function CustomerListProvider({ children }: { children: React.ReactNode }) {
  const [customers, setCustomers] = React.useState<CustomerListItem[]>([]);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(() => {
    setLoading(true);
    apiFetch<CustomerListItem[]>("/admin/customers/list")
      .then((data) => setCustomers(data))
      .catch(() => setCustomers([]))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <CustomerListContext.Provider value={{ customers, loading, refresh }}>
      {children}
    </CustomerListContext.Provider>
  );
}

export function useCustomerList() {
  return React.useContext(CustomerListContext);
}
