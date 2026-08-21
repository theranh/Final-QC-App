---
name: Photo ownership and roles
description: Durable rules for resolving and categorizing saved vehicle photos without mixing galleries.
---

When reopening an intake, resolve photos only through that intake’s canonical quote link. Never choose a quote by VIN recency. Treat the persisted server role as authoritative; unknown legacy slot names belong in a separate unclassified review area, not a best-guess gallery.

**Why:** A VIN can legitimately have multiple quote rows, so a newest-by-VIN fallback can show another record’s photos. Historical data also spans several slot-name eras, so broad prefix guesses can silently misclassify older images.

**How to apply:** New capture paths must declare a role that agrees with the accepted slot convention. Legacy imports and old queued uploads should infer only exact known patterns and preserve every other image as unclassified. If an intake has no quote link but another intake for the VIN owns photos, surface a duplicate-record conflict and require an explicit audited repair rather than silently borrowing that gallery.