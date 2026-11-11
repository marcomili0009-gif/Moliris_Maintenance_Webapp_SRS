// Requisiti soddisfatti: RF-05 (Associazione dati Cliente e Impianto a livello di entità collegate MongoDB)

/**
 * Entità Cliente per gestione anagrafica e relazioni (RF-05)
 */
export interface ClientEntity {
  id: string; // Identificativo univoco del cliente (es. 'cli_...')
  name: string; // Nome Cliente
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Entità Impianto collegata al Cliente (RF-05)
 */
export interface PlantEntity {
  id: string; // Identificativo univoco dell'impianto (es. 'plant_...')
  clientId: string; // Riferimento al cliente proprietario (foreign key logica)
  name: string; // Nome Impianto
  createdAt: Date;
  updatedAt: Date;
}
