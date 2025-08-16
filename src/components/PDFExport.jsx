import React, { useState, useEffect } from 'react';
import { Download, FileText, Image as ImageIcon } from 'lucide-react';
import { Document, Page, Text, View, StyleSheet, pdf, Image, Font } from '@react-pdf/renderer';

// Global image store - this will collect images from all exercise components
window.globalImageStore = window.globalImageStore || {};

// Register fonts for better typography
Font.register({
  family: 'Helvetica',
  fonts: [
  ]
});

// PDF Styles
const styles = StyleSheet.create({
  page: {
    flexDirection: 'column',
    backgroundColor: '#ffffff',
    padding: 40,
    fontFamily: 'Helvetica'
  },
  header: {
    marginBottom: 20,
    borderBottom: '1 solid #e5e7eb',
    paddingBottom: 15
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#1f2937'
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 15
  },
  section: {
    marginBottom: 25
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 12,
    color: '#374151'
  },
  exerciseTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#1f2937'
  },
  text: {
    fontSize: 12,
    marginBottom: 8,
    lineHeight: 1.5,
    color: '#374151'
  },
  inlineText: {
    fontSize: 12,
    marginBottom: 0,
    lineHeight: 1.35,
    color: '#374151'
  },
  context: {
    fontSize: 11,
    fontStyle: 'italic',
    color: '#6b7280',
    marginBottom: 8,
    backgroundColor: '#f9fafb',
    padding: 8
  },
  instructions: {
    fontSize: 11,
    fontStyle: 'italic',
    color: '#059669',
    marginBottom: 8,
    backgroundColor: '#ecfdf5',
    padding: 8
  },
  passage: {
    fontSize: 12,
    marginBottom: 12,
    lineHeight: 1.6,
    color: '#374151'
  },
  blank: {
    fontSize: 12,
    color: '#374151',
    textDecoration: 'underline',
    textDecorationColor: '#d1d5db'
  },
  hints: {
    fontSize: 11,
    color: '#6b7280',
    marginBottom: 8,
    backgroundColor: '#fef3c7',
    padding: 8
  },
  hintItem: {
    fontSize: 11,
    marginBottom: 4,
    color: '#92400e'
  },
  options: {
    fontSize: 11,
    color: '#6b7280',
    marginBottom: 8,
    backgroundColor: '#f3f4f6',
    padding: 8
  },
  optionItem: {
    fontSize: 11,
    marginBottom: 2,
    color: '#374151'
  },
  imageContainer: {
    marginTop: 10,
    marginBottom: 15,
    alignItems: 'center'
  },
  image: {
    maxWidth: 300,
    maxHeight: 200,
    objectFit: 'contain'
  },
  imageCaption: {
    fontSize: 10,
    color: '#6b7280',
    marginTop: 5,
    textAlign: 'center'
  },
  solutionsPage: {
    flexDirection: 'column',
    backgroundColor: '#ffffff',
    padding: 40,
    fontFamily: 'Helvetica'
  },
  solutionsTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    color: '#1f2937',
    textAlign: 'center'
  },
  answer: {
    fontSize: 12,
    marginBottom: 6,
    color: '#059669',
    fontWeight: 'bold'
  },
  rationale: {
    fontSize: 11,
    color: '#6b7280',
    marginBottom: 8,
    fontStyle: 'italic'
  }
});

/**
 * PDF Export Component using @react-pdf/renderer
 * Generates a comprehensive PDF with all exercises, hints, solutions, and images
 * 
 * Features:
 * - Preserves markdown formatting in explanations
 * - Includes generated images (downloads URLs and converts to base64)
 * - Provides sufficient space for handwritten answers
 * - Indexed hints and solutions for easy reference
 * - Modern React-based PDF generation
 * - PROPER IMAGE HANDLING that actually works!
 */
export default function PDFExport({ lesson, orchestratorValues, strictAccents = true }) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [collectedImages, setCollectedImages] = useState({});
  const [preparedImages, setPreparedImages] = useState({});

  // Collect all generated images from the global store and lesson data
  useEffect(() => {
    const collectImages = async () => {
      if (!lesson) return;

      const images = {};
      
      // Collect images from global store (set by exercise components)
      if (window.globalImageStore) {
        console.log('[PDF] Global image store contents:', window.globalImageStore);
        Object.assign(images, window.globalImageStore);
      }

      // Also check lesson data for any stored images
      if (lesson.cloze_passages) {
        lesson.cloze_passages.forEach((item, idx) => {
          if (item.generatedImage) {
            images[`cloze:${idx}`] = item.generatedImage;
          }
        });
      }

      if (lesson.cloze_with_mixed_options) {
        lesson.cloze_with_mixed_options.forEach((item, idx) => {
          if (item.generatedImage) {
            images[`clozeMix:${idx}`] = item.generatedImage;
          }
        });
      }

      console.log('[PDF] Collected images:', images);
      setCollectedImages(images);
    };

    collectImages();

    // Don't clear global image store when lesson changes - let it accumulate
    // return () => {
    //   if (window.globalImageStore) {
    //     window.globalImageStore = {};
    //   }
    // };
  }, [lesson]);

  // Prepare images for @react-pdf/renderer by embedding as data URIs (avoids CORS issues)
  useEffect(() => {
    const isDataUri = (src) => typeof src === 'string' && src.startsWith('data:image');
    const toDataUri = async (url) => {
      try {
        const resp = await fetch(url, { mode: 'cors' });
        const blob = await resp.blob();
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        console.log('[PDF] Failed to fetch image for data URI:', url, e);
        return null;
      }
    };
    const normalizeImageData = async (imageData) => {
      if (!imageData?.data?.[0]) return imageData;
      const image = imageData.data[0] || {};
      let src = image.url || image.imageURL || image.imageDataURI || image.imageBase64Data;
      // If we already have a proper data URI, keep as-is
      if (isDataUri(src)) {
        return imageData;
      }
      // If we have raw base64 without prefix, coerce to png data URI
      if (typeof src === 'string' && src && /^([A-Za-z0-9+/=]+)$/.test(src) && src.length > 100) {
        const coerced = `data:image/png;base64,${src}`;
        const newImage = { ...image, imageDataURI: coerced };
        return { ...imageData, data: [{ ...newImage }] };
      }
      // If we have a remote URL, fetch and convert to data URI
      if (typeof src === 'string' && /^https?:\/\//.test(src)) {
        const dataUri = await toDataUri(src);
        if (dataUri) {
          const newImage = { ...image, imageDataURI: dataUri };
          return { ...imageData, data: [{ ...newImage }] };
        }
      }
      return imageData;
    };

    const prepareAll = async () => {
      const entries = Object.entries(collectedImages || {});
      if (entries.length === 0) {
        setPreparedImages({});
        return;
      }
      const result = {};
      await Promise.all(entries.map(async ([key, img]) => {
        result[key] = await normalizeImageData(img);
      }));
      setPreparedImages(result);
    };

    prepareAll();
  }, [collectedImages]);

  // Helper function to process text formatting (bold, italic, code)
  const processTextFormatting = (text) => {
    if (!text) return [<Text key="empty" style={styles.text}></Text>];

    // Handle bold text first (**text**)
    if (text.includes('**')) {
      const parts = text.split(/(\*\*[^*]+\*\*)/g);
      const processedParts = [];
      
      parts.forEach((part, partIndex) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          const boldText = part.slice(2, -2);
          // Process bold text for italic and code, but not more bold to avoid recursion
          let boldParts = [];
          if (boldText.includes('*') && !boldText.includes('**')) {
            // Handle italic within bold
            const italicParts = boldText.split(/(\*[^*]+\*)/g);
            italicParts.forEach((italicPart, italicIdx) => {
              if (italicPart.startsWith('*') && italicPart.endsWith('*') && !italicPart.startsWith('**')) {
                const italicText = italicPart.slice(1, -1);
                boldParts.push(
                  <Text key={`bold-italic-${partIndex}-${italicIdx}`} style={[styles.text, { fontWeight: 'bold', fontStyle: 'italic' }]}>
                    {italicText}
                  </Text>
                );
              } else if (italicPart) {
                boldParts.push(
                  <Text key={`bold-regular-${partIndex}-${italicIdx}`} style={[styles.text, { fontWeight: 'bold' }]}>
                    {italicPart}
                  </Text>
                );
              }
            });
          } else {
            // No italic, just bold
            boldParts.push(
              <Text key={`bold-${partIndex}`} style={[styles.text, { fontWeight: 'bold' }]}>
                {boldText}
              </Text>
            );
          }
          processedParts.push(...boldParts);
        } else if (part) {
          // Process non-bold parts for italic and code
          if (part.includes('*')) {
            const italicParts = part.split(/(\*[^*]+\*)/g);
            italicParts.forEach((italicPart, italicIdx) => {
              if (italicPart.startsWith('*') && italicPart.endsWith('*')) {
                const italicText = italicPart.slice(1, -1);
                processedParts.push(
                  <Text key={`italic-${partIndex}-${italicIdx}`} style={[styles.text, { fontStyle: 'italic' }]}>
                    {italicText}
                  </Text>
                );
              } else if (italicPart) {
                processedParts.push(
                  <Text key={`regular-${partIndex}-${italicIdx}`} style={styles.text}>
                    {italicPart}
                  </Text>
                );
              }
            });
          } else {
            processedParts.push(
              <Text key={`regular-${partIndex}`} style={styles.text}>
                {part}
              </Text>
            );
          }
        }
      });
      
      return processedParts;
    }

    // Handle italic text (*text*) - only if no ** found
    if (text.includes('*') && !text.includes('**')) {
      const parts = text.split(/(\*[^*]+\*)/g);
      const processedParts = [];
      
      parts.forEach((part, partIndex) => {
        if (part.startsWith('*') && part.endsWith('*') && !part.startsWith('**')) {
          const italicText = part.slice(1, -1);
          processedParts.push(
            <Text key={`italic-${partIndex}`} style={[styles.text, { fontStyle: 'italic' }]}>
              {italicText}
            </Text>
          );
        } else if (part) {
          processedParts.push(
            <Text key={`regular-${partIndex}`} style={styles.text}>
              {part}
            </Text>
          );
        }
      });
      
      return processedParts;
    }

    // Handle inline code (`code`)
    if (text.includes('`')) {
      const parts = text.split(/(`[^`]+`)/g);
      const processedParts = [];
      
      parts.forEach((part, partIndex) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          const codeText = part.slice(1, -1);
          processedParts.push(
            <Text key={`code-${partIndex}`} style={[styles.text, { 
              fontFamily: 'Courier',
              backgroundColor: '#f3f4f6',
              fontSize: 10,
              paddingHorizontal: 2
            }]}>
              {codeText}
            </Text>
          );
        } else if (part) {
          processedParts.push(
            <Text key={`regular-${partIndex}`} style={styles.text}>
              {part}
            </Text>
          );
        }
      });
      
      return processedParts;
    }

    // Return plain text
    return [<Text key="plain" style={styles.text}>{text}</Text>];
  };

  // Enhanced markdown renderer with table support (similar to ExplanationComponent)
  const renderMarkdownText = (text) => {
    if (!text) return null;

    const lines = text.split('\n');
    const elements = [];
    let inTable = false;
    let tableRows = [];
    let isHeaderRow = false;

    const flushTable = () => {
      if (tableRows.length > 0) {
        // Render table
        const headerRow = tableRows[0];
        const dataRows = tableRows.slice(2); // Skip header and separator row
        
        elements.push(
          <View key={`table-${elements.length}`} style={{
            marginVertical: 8,
            border: '1 solid #d1d5db'
          }}>
            {/* Table Header */}
            <View style={{ 
              flexDirection: 'row', 
              backgroundColor: '#f3f4f6',
              borderBottom: '1 solid #d1d5db'
            }}>
              {headerRow.map((cell, cellIdx) => (
                <View key={cellIdx} style={{
                  flex: 1,
                  padding: 6,
                  borderRight: cellIdx < headerRow.length - 1 ? '1 solid #d1d5db' : 'none'
                }}>
                  <Text style={[styles.text, { fontWeight: 'bold', fontSize: 11 }]}>
                    {cell.trim()}
                  </Text>
                </View>
              ))}
            </View>
            
            {/* Table Data Rows */}
            {dataRows.map((row, rowIdx) => (
              <View key={rowIdx} style={{ 
                flexDirection: 'row',
                borderBottom: rowIdx < dataRows.length - 1 ? '1 solid #e5e7eb' : 'none'
              }}>
                {row.map((cell, cellIdx) => (
                  <View key={cellIdx} style={{
                    flex: 1,
                    padding: 6,
                    borderRight: cellIdx < row.length - 1 ? '1 solid #e5e7eb' : 'none'
                  }}>
                    <Text style={[styles.text, { fontSize: 10 }]}>
                      {cell.trim()}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        );
        tableRows = [];
        inTable = false;
      }
    };

    lines.forEach((line, lineIndex) => {
      // Handle table rows
      if (line.includes('|') && line.split('|').length > 2) {
        if (!inTable) {
          inTable = true;
          isHeaderRow = true;
        }
        
        const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);
        
        // Skip separator rows (contain only dashes and pipes)
        if (!line.match(/^\s*\|?\s*:?-+:?\s*\|/)) {
          tableRows.push(cells);
        }
        return;
      } else if (inTable) {
        // End of table, flush it
        flushTable();
      }

      if (line.trim() === '') {
        elements.push(<Text key={`empty-${lineIndex}`} style={styles.text}>&nbsp;</Text>);
        return;
      }

      // Handle headers
      if (line.startsWith('#')) {
        const level = line.match(/^#+/)[0].length;
        const headerText = line.replace(/^#+\s*/, '');
        const headerStyle = level === 1 ? { fontSize: 16, fontWeight: 'bold', marginBottom: 8, marginTop: 12 } : 
                           level === 2 ? { fontSize: 14, fontWeight: 'bold', marginBottom: 6, marginTop: 10 } : 
                           { fontSize: 13, fontWeight: 'bold', marginBottom: 4, marginTop: 8 };
        
        const processedHeaderText = processTextFormatting(headerText);
        elements.push(
          <View key={`header-${lineIndex}`} style={{ flexDirection: 'row', flexWrap: 'wrap', ...headerStyle }}>
            {processedHeaderText.map((textElement, idx) => 
              React.cloneElement(textElement, { 
                key: `header-text-${idx}`,
                style: [textElement.props.style, headerStyle] 
              })
            )}
          </View>
        );
        return;
      }

      // Handle lists
      if (line.match(/^\s*[-*+]\s/)) {
        const listText = line.replace(/^\s*[-*+]\s/, '');
        const processedListText = processTextFormatting(listText);
        elements.push(
          <View key={`list-${lineIndex}`} style={{ flexDirection: 'row', marginLeft: 12, marginBottom: 3 }}>
            <Text style={styles.text}>• </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', flex: 1 }}>
              {processedListText}
            </View>
          </View>
        );
        return;
      }

      if (line.match(/^\s*\d+\.\s/)) {
        const listText = line.replace(/^\s*\d+\.\s/, '');
        const number = line.match(/^\s*(\d+)\./)[1];
        const processedListText = processTextFormatting(listText);
        elements.push(
          <View key={`numlist-${lineIndex}`} style={{ flexDirection: 'row', marginLeft: 12, marginBottom: 3 }}>
            <Text style={styles.text}>{number}. </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', flex: 1 }}>
              {processedListText}
            </View>
          </View>
        );
        return;
      }

      // Apply text formatting to any text content
      const processedText = processTextFormatting(line);
      elements.push(
        <View key={`line-${lineIndex}`} style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {processedText}
        </View>
      );
    });

    // Flush any remaining table
    if (inTable) {
      flushTable();
    }

    return elements;
  };

  // Helper function to render blanks as underscores for handwriting
  const renderBlanks = (text) => {
    if (!text) return null;

    const parts = text.split('_____');
    const elements = [];

    parts.forEach((part, index) => {
      if (part) {
        elements.push(
          <Text key={`text-${index}`} style={styles.inlineText}>
            {part}
          </Text>
        );
      }
      if (index < parts.length - 1) {
        elements.push(
          <Text key={`blank-${index}`} style={[styles.inlineText, { fontFamily: 'Courier' }]}> 
            ____________
          </Text>
        );
      }
    });

    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {elements}
      </View>
    );
  };

  // Helper function to generate solutions for Cloze exercises
  const generateClozeSolutions = (item) => {
    if (!item?.blanks || !Array.isArray(item.blanks)) return [];
    return item.blanks.map(blank => blank.answer || '').filter(answer => answer);
  };

  // Helper function to generate solutions for Cloze Mixed exercises  
  const generateClozeMixedSolutions = (item) => {
    if (!item?.blanks || !Array.isArray(item.blanks)) return [];
    return item.blanks.map(blank => {
      if (blank.options && blank.correct_index >= 0) {
        return blank.options[blank.correct_index] || '';
      }
      return '';
    }).filter(answer => answer);
  };

  // Helper function to render Cloze Mixed with inline options and footnotes
  const renderClozeMixedWithOptions = (item) => {
    if (!item?.passage) {
      console.log('[PDF] ClozeMixed item has no passage:', item);
      return { elements: [], footnotes: [] };
    }

    console.log('[PDF] Rendering ClozeMixed item:', item);
    
    const parts = item.passage.split('_____');
    const blanks = Array.isArray(item.blanks) ? item.blanks : [];
    const elements = [];
    const footnotes = [];
    let footnoteCounter = 1;

    console.log('[PDF] ClozeMixed parts:', parts.length - 1, 'blanks:', blanks.length);

    for (let i = 0; i < parts.length; i++) {
      // Add text part
      if (parts[i]) {
        elements.push(
          <Text key={`text-${i}`} style={styles.inlineText}>
            {parts[i]}
          </Text>
        );
      }

      // Add options inline instead of blank
      if (i < parts.length - 1) {
        const blank = blanks.find(b => b.index === i) || { options: [], hint: '' };
        console.log(`[PDF] Blank ${i}:`, blank);
        
        if (blank.options && blank.options.length > 0) {
          const optionsText = `[${blank.options.join(' / ')}]`;
          let footnoteNumber = null;
          
          // Add footnote if there's a hint
          if (blank.hint) {
            footnoteNumber = footnoteCounter++;
            footnotes.push({
              number: footnoteNumber,
              text: blank.hint
            });
          }
          
          elements.push(
            <Text key={`options-${i}`} style={[styles.inlineText, { fontSize: 11 }]}> 
              {optionsText}
              {footnoteNumber && (
                <Text style={[styles.inlineText, { fontSize: 9 }]}>[{footnoteNumber}]</Text>
              )}
            </Text>
          );
        } else {
          // Add a placeholder blank if no options found
          elements.push(
            <Text key={`blank-${i}`} style={[styles.inlineText, { fontFamily: 'Courier' }]}> 
              ____________
            </Text>
          );
        }
      }
    }

    console.log('[PDF] ClozeMixed elements generated:', elements.length, 'footnotes:', footnotes.length);
    return { elements, footnotes };
  };

  // Helper function to render regular Cloze with footnotes
  const renderClozeWithFootnotes = (item) => {
    if (!item?.passage) return null;

    const parts = item.passage.split('_____');
    const blanks = Array.isArray(item.blanks) ? item.blanks : [];
    const elements = [];
    const footnotes = [];
    let footnoteCounter = 1;

    for (let i = 0; i < parts.length; i++) {
      // Add text part
      if (parts[i]) {
        elements.push(
          <Text key={`text-${i}`} style={styles.inlineText}>
            {parts[i]}
          </Text>
        );
      }

      // Add blank with optional footnote
      if (i < parts.length - 1) {
        const blank = blanks.find(b => b.index === i) || { hint: '' };
        let footnoteNumber = null;
        
        // Add footnote if there's a hint
        if (blank.hint) {
          footnoteNumber = footnoteCounter++;
          footnotes.push({
            number: footnoteNumber,
            text: blank.hint
          });
        }
        
        elements.push(
          <Text key={`blank-${i}`} style={[styles.inlineText, { fontFamily: 'Courier' }]}> 
            ____________
            {footnoteNumber && (
              <Text style={[styles.inlineText, { fontSize: 9 }]}>[{footnoteNumber}]</Text>
            )}
          </Text>
        );
      }
    }

    return { elements, footnotes };
  };

  // Helper function to render footnotes
  const renderFootnotes = (footnotes, title = "Hints:") => {
    if (!footnotes || footnotes.length === 0) return null;

    return (
      <View style={{ marginTop: 12, borderTop: '1 solid #e5e7eb', paddingTop: 8 }}>
        <Text style={[styles.text, { fontSize: 10, fontWeight: 'bold', marginBottom: 4 }]}>{title}</Text>
        {footnotes.map((footnote, idx) => (
          <Text key={`footnote-${idx}`} style={[styles.inlineText, { fontSize: 9, marginBottom: 2, marginLeft: 8 }]}>
            [<Text style={[styles.inlineText, { fontSize: 9 }]}>{footnote.number}</Text>] {footnote.text}
          </Text>
        ))}
      </View>
    );
  };

  // Helper function to render FIB solutions with answers in green bold
  const renderFIBSolution = (item) => {
    if (!item?.sentence) return null;

    const parts = item.sentence.split('_____');
    const answers = Array.isArray(item.answers) ? item.answers : [];
    const elements = [];

    for (let i = 0; i < parts.length; i++) {
      // Add text part
      if (parts[i]) {
        elements.push(
          <Text key={`text-${i}`} style={styles.inlineText}>
            {parts[i]}
          </Text>
        );
      }

      // Add answer in green bold instead of blank
      if (i < parts.length - 1) {
        const answer = answers[i] || answers[0] || '[missing]';
        
        elements.push(
          <Text key={`answer-${i}`} style={[styles.inlineText, { 
            fontWeight: 'bold', 
            color: '#059669'
          }]}> 
            {answer}
          </Text>
        );
      }
    }

    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {elements}
      </View>
    );
  };

  // Helper function to render Cloze solutions with answers and rationale footnotes
  const renderClozeSolution = (item) => {
    if (!item?.passage) return null;

    const parts = item.passage.split('_____');
    const blanks = Array.isArray(item.blanks) ? item.blanks : [];
    const elements = [];
    const footnotes = [];
    let footnoteCounter = 1;

    for (let i = 0; i < parts.length; i++) {
      // Add text part
      if (parts[i]) {
        elements.push(
          <Text key={`text-${i}`} style={styles.inlineText}>
            {parts[i]}
          </Text>
        );
      }

      // Add answer in green bold with optional rationale footnote
      if (i < parts.length - 1) {
        const blank = blanks.find(b => b.index === i) || { answer: '[missing]', rationale: '' };
        let footnoteNumber = null;
        
        // Add footnote for rationale if available
        if (blank.rationale) {
          footnoteNumber = footnoteCounter++;
          footnotes.push({
            number: footnoteNumber,
            text: blank.rationale
          });
        }
        
        elements.push(
          <Text key={`answer-${i}`} style={[styles.inlineText, { 
            fontWeight: 'bold', 
            color: '#059669'
          }]}> 
            {blank.answer}
            {footnoteNumber && (
              <Text style={[styles.inlineText, { fontSize: 9 }]}>[{footnoteNumber}]</Text>
            )}
          </Text>
        );
      }
    }

    return { elements, footnotes };
  };

  // Helper function to render Cloze Mixed solutions with highlighted correct and strikethrough incorrect
  const renderClozeMixedSolution = (item) => {
    if (!item?.passage) return null;

    const parts = item.passage.split('_____');
    const blanks = Array.isArray(item.blanks) ? item.blanks : [];
    const elements = [];
    const footnotes = [];
    let footnoteCounter = 1;

    for (let i = 0; i < parts.length; i++) {
      // Add text part
      if (parts[i]) {
        elements.push(
          <Text key={`text-${i}`} style={styles.inlineText}>
            {parts[i]}
          </Text>
        );
      }

      // Add options with correct highlighted and incorrect struck through
      if (i < parts.length - 1) {
        const blank = blanks.find(b => b.index === i) || { options: [], correct_index: -1, rationale: '' };
        
        if (blank.options && blank.options.length > 0) {
          const optionElements = [];
          let footnoteNumber = null;
          
          // Add footnote for rationale if available
          if (blank.rationale) {
            footnoteNumber = footnoteCounter++;
            footnotes.push({
              number: footnoteNumber,
              text: blank.rationale
            });
          }
          
          blank.options.forEach((option, optIdx) => {
            const isCorrect = optIdx === blank.correct_index;
            
            if (optIdx > 0) {
              optionElements.push(
                <Text key={`sep-${optIdx}`} style={styles.inlineText}> / </Text>
              );
            }
            
            optionElements.push(
              <Text key={`opt-${optIdx}`} style={[styles.inlineText, {
                fontWeight: 'normal',
                color: isCorrect ? '#059669' : '#6b7280',
                textDecoration: isCorrect ? 'underline' : 'line-through'
              }]}> 
                {option}
              </Text>
            );
          });
          
          elements.push(
            <Text key={`options-${i}`} style={[styles.inlineText, { fontSize: 11 }]}>[
            </Text>
          );
          elements.push(...optionElements);
          elements.push(
            <Text key={`options-close-${i}`} style={[styles.inlineText, { fontSize: 11 }]}>] 
              {footnoteNumber && (
                <Text style={[styles.inlineText, { fontSize: 9 }]}>[{footnoteNumber}]</Text>
              )}
            </Text>
          );
        }
      }
    }

    return { elements, footnotes };
  };

  // Helper function to render an image with proper error handling
  const renderImage = (imageData, caption) => {
    console.log('[PDF] Attempting to render image:', imageData);
    
    if (!imageData?.data?.[0]) {
      console.log('[PDF] No image data found');
      return null;
    }

    const image = imageData.data[0];
    // Prefer embedded data URIs first to avoid remote fetch/CORS issues
    const imageSource = image.imageDataURI || image.imageBase64Data || image.url || image.imageURL;
    
    console.log('[PDF] Image source:', imageSource);
    
    if (!imageSource) {
      console.log('[PDF] No valid image source found');
      return null;
    }

    return (
      <View style={styles.imageContainer}>
        <Image 
          src={imageSource} 
          style={styles.image}
          cache={false}
        />
        {caption && (
          <Text style={styles.imageCaption}>
            {caption}
          </Text>
        )}
      </View>
    );
  };

  // Helper to access latest image by key from prepared, collected, or global store
  const getImageByKey = (key) => {
    const fromPrepared = preparedImages && preparedImages[key];
    if (fromPrepared) return fromPrepared;
    const fromCollected = collectedImages && collectedImages[key];
    if (fromCollected) return fromCollected;
    if (typeof window !== 'undefined' && window.globalImageStore) {
      const fromGlobal = window.globalImageStore[key];
      if (fromGlobal) return fromGlobal;
    }
    return null;
  };

  // PDF Document Component
  const PDFDocument = () => (
    <Document>
      {/* Main Content Page */}
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Language Practice Lesson</Text>
          <Text style={styles.subtitle}>
            Language: {lesson.language || 'Spanish'} | Level: {lesson.level || 'B1'}
          </Text>
        </View>

        {/* Explanation Section */}
        {lesson.explanation && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Explanation</Text>
            {lesson.explanation.title && (
              <Text style={[styles.text, { fontWeight: 'bold', fontSize: 14 }]}>
                {lesson.explanation.title}
              </Text>
            )}
            {lesson.explanation.content_markdown && (
              <View>
                {renderMarkdownText(lesson.explanation.content_markdown)}
              </View>
            )}
          </View>
        )}

        {/* Fill in the Blanks Section */}
        {Array.isArray(lesson.fill_in_blanks) && lesson.fill_in_blanks.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Fill in the Blanks</Text>
            {lesson.fill_in_blanks.map((item, idx) => (
              <View key={`fib-${idx}`} style={{ marginBottom: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 4 }}>
                  <Text style={[styles.text, { fontWeight: 'bold', marginRight: 4 }]}>
                    {String.fromCharCode(97 + idx)}.
                  </Text>
                  <View style={{ flex: 1 }}>
                    {renderBlanks(item.sentence)}
                  </View>
                </View>
                {item.context && (
                  <Text style={styles.context}>Context: {item.context}</Text>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Multiple Choice Section */}
        {Array.isArray(lesson.multiple_choice) && lesson.multiple_choice.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Multiple Choice Questions</Text>
            {lesson.multiple_choice.map((item, idx) => (
              <View key={`mcq-${idx}`} style={{ marginBottom: 12 }}>
                <Text style={[styles.text, { fontWeight: 'bold', marginBottom: 4 }]}>
                  {String.fromCharCode(97 + idx)}. {item.question}
                </Text>
                
                {item.options && Array.isArray(item.options) && (
                  <View style={styles.options}>
                    {item.options.map((option, optIdx) => (
                      <Text key={`option-${optIdx}`} style={styles.optionItem}>
                        {String.fromCharCode(65 + optIdx)}. {option.text}
                      </Text>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Cloze Passages Section */}
        {Array.isArray(lesson.cloze_passages) && lesson.cloze_passages.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Cloze Passages</Text>
            {lesson.cloze_passages.map((item, idx) => {
              const { elements, footnotes } = renderClozeWithFootnotes(item) || { elements: [], footnotes: [] };
              
              return (
                <View key={`cloze-${idx}`} style={{ marginBottom: 20 }}>
                  <Text style={styles.exerciseTitle}>
                    Exercise {idx + 1}{item.title ? `: ${item.title}` : ''}
                  </Text>
                  
                  {item.studentInstructions && (
                    <Text style={styles.instructions}>{item.studentInstructions}</Text>
                  )}
                  
                  <View style={{ flexDirection: 'row', gap: 15 }}>
                    <View style={{ flex: 1 }}>
                      <View style={{ marginBottom: 8, flexDirection: 'row', flexWrap: 'wrap' }}>
                        {elements}
                      </View>
                      
                      {/* Render footnotes */}
                      {renderFootnotes(footnotes)}
                    </View>
                    
                    {/* Render generated image if available */}
                    {getImageByKey(`cloze:${idx}`) && (
                      <View style={{ width: 150 }}>
                        {renderImage(getImageByKey(`cloze:${idx}`), 'AI-generated illustration')}
                      </View>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* Cloze Mixed Options Section */}
        {Array.isArray(lesson.cloze_with_mixed_options) && lesson.cloze_with_mixed_options.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Cloze with Mixed Options</Text>
            <Text style={[styles.text, { fontSize: 10, fontStyle: 'italic', marginBottom: 12, color: '#6b7280' }]}>
              Underline the correct option for each blank.
            </Text>
            {lesson.cloze_with_mixed_options.map((item, idx) => {
              const { elements, footnotes } = renderClozeMixedWithOptions(item) || { elements: [], footnotes: [] };
              
              return (
                <View key={`clozeMix-${idx}`} style={{ marginBottom: 20 }}>
                  <Text style={styles.exerciseTitle}>
                    Exercise {idx + 1}{item.title ? `: ${item.title}` : ''}
                  </Text>
                  
                  {item.studentInstructions && (
                    <Text style={styles.instructions}>{item.studentInstructions}</Text>
                  )}
                  
                  <View style={{ flexDirection: 'row', gap: 15 }}>
                    <View style={{ flex: 1 }}>
                      <View style={{ marginBottom: 8, flexDirection: 'row', flexWrap: 'wrap' }}>
                        {elements}
                      </View>
                      
                      {/* Render footnotes */}
                      {renderFootnotes(footnotes)}
                    </View>
                    
                    {/* Render generated image if available */}
                    {getImageByKey(`clozeMix:${idx}`) && (
                      <View style={{ width: 150 }}>
                        {renderImage(getImageByKey(`clozeMix:${idx}`), 'AI-generated illustration')}
                      </View>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </Page>

      {/* Solutions Page */}
      <Page size="A4" style={styles.solutionsPage}>
        <Text style={styles.solutionsTitle}>Solutions and Answers</Text>

        {/* Fill in the Blanks Solutions */}
        {Array.isArray(lesson.fill_in_blanks) && lesson.fill_in_blanks.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Fill in the Blanks - Solutions</Text>
            {lesson.fill_in_blanks.map((item, idx) => (
              <View key={`fib-sol-${idx}`} style={{ marginBottom: 15 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 4 }}>
                  <Text style={[styles.text, { fontWeight: 'bold', marginRight: 4 }]}>
                    {String.fromCharCode(97 + idx)}.
                  </Text>
                  <View style={{ flex: 1 }}>
                    {renderFIBSolution(item)}
                  </View>
                </View>
                {item.context && (
                  <Text style={[styles.context, { marginLeft: 16 }]}>Context: {item.context}</Text>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Multiple Choice Solutions */}
        {Array.isArray(lesson.multiple_choice) && lesson.multiple_choice.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Multiple Choice - Solutions</Text>
            {lesson.multiple_choice.map((item, idx) => (
              <View key={`mcq-sol-${idx}`} style={{ marginBottom: 15 }}>
                <Text style={[styles.text, { fontWeight: 'bold', marginBottom: 4 }]}>
                  {String.fromCharCode(97 + idx)}. {item.question}
                </Text>
                {item.options && Array.isArray(item.options) && (
                  <View style={{ marginLeft: 16 }}>
                    {item.options.map((option, optIdx) => {
                      if (option.correct) {
                        return (
                          <View key={`correct-${optIdx}`}>
                            <Text style={[styles.answer, { marginBottom: 4 }]}>
                              Correct Answer: {String.fromCharCode(65 + optIdx)}. {option.text}
                            </Text>
                            {option.rationale && (
                              <Text style={styles.rationale}>Rationale: {option.rationale}</Text>
                            )}
                          </View>
                        );
                      }
                      return null;
                    })}
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Cloze Passages Solutions */}
        {Array.isArray(lesson.cloze_passages) && lesson.cloze_passages.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Cloze Passages - Solutions</Text>
            {lesson.cloze_passages.map((item, idx) => {
              const { elements, footnotes } = renderClozeSolution(item) || { elements: [], footnotes: [] };
              
              return (
                <View key={`cloze-sol-${idx}`} style={{ marginBottom: 20 }}>
                  <Text style={styles.exerciseTitle}>
                    Exercise {idx + 1}{item.title ? `: ${item.title}` : ''}
                  </Text>
                  
                  <View style={{ marginBottom: 8, flexDirection: 'row', flexWrap: 'wrap' }}>
                    {elements}
                  </View>
                  
                  {/* Render rationale footnotes */}
                  {renderFootnotes(footnotes, "Rationales:")}
                </View>
              );
            })}
          </View>
        )}

        {/* Cloze Mixed Options Solutions */}
        {Array.isArray(lesson.cloze_with_mixed_options) && lesson.cloze_with_mixed_options.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Cloze with Mixed Options - Solutions</Text>
            <Text style={[styles.text, { fontSize: 10, fontStyle: 'italic', marginBottom: 12, color: '#6b7280' }]}>
              Correct answers are highlighted in green. Incorrect options are struck through.
            </Text>
            {lesson.cloze_with_mixed_options.map((item, idx) => {
              const { elements, footnotes } = renderClozeMixedSolution(item) || { elements: [], footnotes: [] };
              
              return (
                <View key={`clozeMix-sol-${idx}`} style={{ marginBottom: 20 }}>
                  <Text style={styles.exerciseTitle}>
                    Exercise {idx + 1}{item.title ? `: ${item.title}` : ''}
                  </Text>
                  
                  <View style={{ marginBottom: 8, flexDirection: 'row', flexWrap: 'wrap' }}>
                    {elements}
                  </View>
                  
                  {/* Render rationale footnotes */}
                  {renderFootnotes(footnotes, "Rationales:")}
                </View>
              );
            })}
          </View>
        )}
      </Page>
    </Document>
  );

  const generatePDF = async () => {
    if (!lesson) return;

    setIsGenerating(true);
    try {
      console.log('[PDF] Starting PDF generation with lesson:', lesson);
      console.log('[PDF] ClozeMixed items:', lesson.cloze_with_mixed_options);
      // Refresh collected images from the global store right before rendering
      const latest = { ...(window.globalImageStore || {}) };
      if (lesson.cloze_passages) {
        lesson.cloze_passages.forEach((item, idx) => {
          if (item.generatedImage) latest[`cloze:${idx}`] = item.generatedImage;
        });
      }
      if (lesson.cloze_with_mixed_options) {
        lesson.cloze_with_mixed_options.forEach((item, idx) => {
          if (item.generatedImage) latest[`clozeMix:${idx}`] = item.generatedImage;
        });
      }
      setCollectedImages(latest);
      
      const blob = await pdf(<PDFDocument />).toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `language-practice-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('PDF generation failed with error:', error);
      console.error('Error stack:', error.stack);
      console.error('Lesson data:', lesson);
      
      // More user-friendly error message
      const errorMsg = error.message || 'Unknown error occurred during PDF generation';
      alert(`Failed to generate PDF: ${errorMsg}\n\nCheck the console for details.`);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <button
      onClick={generatePDF}
      disabled={isGenerating || !lesson}
      className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
      title="Export lesson to PDF with images and proper formatting"
    >
      <FileText size={18} />
      <Download size={18} />
      {collectedImages && Object.keys(collectedImages).filter(key => collectedImages[key] && collectedImages[key].data?.[0]).length > 0 && <ImageIcon size={18} className="text-yellow-300" />}
      {isGenerating ? 'Generating...' : 'Export PDF'}
    </button>
  );
}
