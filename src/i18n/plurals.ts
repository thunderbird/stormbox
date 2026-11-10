/** Catalog forms follow CLDR order: zero, one, two, few, many, other. */
export function pluralRule(locale: string) {
  const rules = new Intl.PluralRules(locale);
  const supported = rules.resolvedOptions().pluralCategories;
  const categories = ['zero', 'one', 'two', 'few', 'many', 'other'].filter((item) => supported.includes(item as Intl.LDMLPluralRule));
  return (count: number, choicesLength: number): number => {
    const category = rules.select(count);
    if (choicesLength === 1) return 0;
    if (choicesLength === 2) return category === 'one' ? 0 : 1;
    // English source messages may distinguish zero explicitly.
    if (choicesLength === 3 && categories.length === 2) return count === 0 ? 0 : category === 'one' ? 1 : 2;
    return Math.min(Math.max(0, categories.indexOf(category)), choicesLength - 1);
  };
}
