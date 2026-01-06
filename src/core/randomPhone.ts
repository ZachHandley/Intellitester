import { parsePhoneNumber, CountryCode, isValidPhoneNumber } from 'libphonenumber-js';

// Country-specific phone number formats (area codes and subscriber ranges)
const COUNTRY_FORMATS: Record<string, { areaCode: () => string; subscriber: () => string }> = {
  US: {
    areaCode: () => {
      // Valid US area codes (avoid reserved ones like 555)
      const areaCodes = ['201', '212', '213', '310', '312', '404', '415', '512', '617', '702', '713', '718', '805', '818', '917'];
      return areaCodes[Math.floor(Math.random() * areaCodes.length)];
    },
    subscriber: () => String(Math.floor(Math.random() * 9000000) + 1000000).slice(0, 7),
  },
  GB: {
    areaCode: () => {
      const areaCodes = ['20', '121', '131', '141', '151', '161', '171', '181'];
      return areaCodes[Math.floor(Math.random() * areaCodes.length)];
    },
    subscriber: () => String(Math.floor(Math.random() * 90000000) + 10000000).slice(0, 8),
  },
  DE: {
    areaCode: () => {
      const areaCodes = ['30', '40', '69', '89', '211', '221', '341', '351'];
      return areaCodes[Math.floor(Math.random() * areaCodes.length)];
    },
    subscriber: () => String(Math.floor(Math.random() * 9000000) + 1000000).slice(0, 7),
  },
  FR: {
    areaCode: () => {
      const areaCodes = ['1', '2', '3', '4', '5'];
      return areaCodes[Math.floor(Math.random() * areaCodes.length)];
    },
    subscriber: () => String(Math.floor(Math.random() * 90000000) + 10000000).slice(0, 8),
  },
  AU: {
    areaCode: () => {
      const areaCodes = ['2', '3', '7', '8'];
      return areaCodes[Math.floor(Math.random() * areaCodes.length)];
    },
    subscriber: () => String(Math.floor(Math.random() * 90000000) + 10000000).slice(0, 8),
  },
};

/**
 * Generate a random valid phone number for a given country
 * @param country - ISO 3166-1 alpha-2 country code (default: 'US')
 * @returns Phone number in E.164 format (e.g., +14155551234)
 */
export function generateRandomPhone(country: string = 'US'): string {
  const countryCode = country.toUpperCase() as CountryCode;
  const format = COUNTRY_FORMATS[countryCode] || COUNTRY_FORMATS['US'];

  // Try up to 10 times to generate a valid number
  for (let i = 0; i < 10; i++) {
    const areaCode = format.areaCode();
    const subscriber = format.subscriber();
    const nationalNumber = areaCode + subscriber;

    try {
      // Format as national number and let libphonenumber parse it
      const phoneNumber = parsePhoneNumber(nationalNumber, countryCode);
      if (phoneNumber && isValidPhoneNumber(phoneNumber.number)) {
        return phoneNumber.format('E.164');
      }
    } catch {
      // Try again
    }
  }

  // Fallback: return a simple formatted number
  const fallbackFormat = COUNTRY_FORMATS[countryCode] || COUNTRY_FORMATS['US'];
  const areaCode = fallbackFormat.areaCode();
  const subscriber = fallbackFormat.subscriber();

  // Get country calling code
  const callingCodes: Record<string, string> = {
    US: '1', GB: '44', DE: '49', FR: '33', AU: '61',
  };
  const callingCode = callingCodes[countryCode] || '1';

  return `+${callingCode}${areaCode}${subscriber}`;
}
