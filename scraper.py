import os
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse
import re

URLS_TO_SCRAPE = [
    "https://www.uscis.gov/policy-manual/volume-6-part-g-chapter-2",
    "https://www.uscis.gov/policy-manual/volume-6-part-e-chapter-7",
]
OUTPUT_DIR = "data"

def scrape_and_save(url):
    try:
        print(f"Scraping URL: {url}...")
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        response = requests.get(url, headers=headers)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, 'html.parser')

        # More resilient: try a list of potential selectors for the main content
        content_selectors = [
            'div[class*="page-content"]',
            'div[id*="main-content"]',
            'main[role="main"]',
            'article',
            'div.c-main-content__inner' # The one from before
        ]

        main_content = None
        for selector in content_selectors:
            main_content = soup.select_one(selector)
            if main_content:
                print(f"  [Info] Found content with selector: '{selector}'")
                break

        if not main_content:
            print(f"  [Warning] Could not find the main content block for {url}. Skipping.")
            return

        # Remove known junk elements
        for element in main_content.select('nav, header, footer, .usa-alert, .c-page-header, .usa-breadcrumb'):
            element.decompose()

        text = main_content.get_text(separator='\n', strip=True)
        cleaned_text = re.sub(r'\n{3,}', '\n\n', text)

        parsed_url = urlparse(url)
        filename = parsed_url.path.strip("/").replace('/', '_') + ".txt"
        filepath = os.path.join(OUTPUT_DIR, filename)

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(cleaned_text)

        print(f"  [Success] Saved clean content to {filepath}")

    except Exception as e:
        print(f"  [Error] An error occurred for {url}. Reason: {e}")

def main():
    print("--- Starting Resilient Scraper (v3) ---")
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
    for url in URLS_TO_SCRAPE:
        scrape_and_save(url)
    print("--- Scraping Complete ---")

if __name__ == "__main__":
    main()