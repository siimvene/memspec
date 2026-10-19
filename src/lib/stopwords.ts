/**
 * Shared stopword list. Owned by search coverage (`classifyCoverage`) and
 * reused by `memspec check` for its title-term signal, so both judge
 * "content-bearing word" identically.
 */

/**
 * Function words that carry no topical signal. A natural-language query
 * ("does the kvart gateway use mtls") must not read as covered because a hit
 * happens to contain "does", "the" and "use". Checked against the raw
 * lowercased word (punctuation trimmed), before stemming.
 */
export const COVERAGE_STOPWORDS = new Set([
  'a', 'about', 'after', 'again', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'during',
  'each', 'ever', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'having', 'here', 'how',
  'if', 'in', 'into', 'is', 'it', 'its', 'just', 'like', 'made', 'make', 'me', 'more', 'most', 'my',
  'need', 'needs', 'never', 'no', 'not', 'now', 'of', 'on', 'only', 'or', 'other', 'our', 'out', 'over',
  'per', 'same', 'should', 'so', 'some', 'still', 'such', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'to', 'up', 'use', 'used', 'uses', 'using',
  'very', 'via', 'was', 'way', 'we', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'who',
  'why', 'will', 'with', 'within', 'without', 'would', 'you', 'your',
]);
