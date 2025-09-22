import os
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse
import re

# --- Configuration ---
# CORRECTED AND VERIFIED URLS
URLS_TO_SCRAPE = [
    "https://www.uscis.gov/policy-manual/volume-6-part-g-chapter-2", # H-1B Beneficiary Qualifications
    "https://www.uscis.gov/policy-manual/volume-6-part-e-chapter-7", # F-1 Optional Practical Training (OPT)
    "https://www.uscis.gov/policy-manual/volume-6-part-a-chapter-5"  # Admissibility of Applicants
]
OUTPUT_DIR = "data"

def scrape_and_save(url):
    """Fetches a URL, extracts main content, cleans it, and saves it."""
    try:
        print(f"Scraping URL: {url}...")

        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        response = requests.get(url, headers=headers)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, 'html.parser')

        # MORE ROBUST: Try a list of potential selectors for the main content
        content_selectors = [
            'div.uscis-policy-manual-body', 
            'div.c-main-content',
            'div.text-content',
            'article'
        ]

        main_content = None
        for selector in content_selectors:
            main_content = soup.select_one(selector)
            if main_content:
                break # Found a working selector

        if not main_content:
            print(f"  [Warning] Could not find the main content block for {url} with any known selector. Skipping.")
            return

        # Clean the text: remove extra whitespace and multiple newlines
        text = main_content.get_text(separator='\n', strip=True)
        cleaned_text = re.sub(r'\n{3,}', '\n\n', text) # Replace 3+ newlines with 2

        # Generate a clean filename
        parsed_url = urlparse(url)
        filename = parsed_url.path.strip("/").replace('/', '_') + ".txt"
        filepath = os.path.join(OUTPUT_DIR, filename)

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(cleaned_text)

        print(f"  [Success] Saved content to {filepath}")

    except requests.RequestException as e:
        print(f"  [Error] Could not fetch URL {url}. Reason: {e}")
    except Exception as e:
        print(f"  [Error] An unexpected error occurred for {url}. Reason: {e}")

def main():
    """Main function to run the scraper."""
    print("--- Starting Web Scraper (v2) ---")

    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        print(f"Created directory: {OUTPUT_DIR}")

    for url in URLS_TO_SCRAPE:
        scrape_and_save(url)

    print("--- Scraping Complete ---")

if __name__ == "__main__":
    main()